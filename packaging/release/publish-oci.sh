#!/usr/bin/env bash
# Push a packaged chart to OCI and sign its digest keyless. Run only by github.com/aient-ai/helm-charts's release
# workflow, packaging/release/public-repo/release.yml.
#
#   publish-oci.sh <chart> <version> <packaged .tgz>
#
# Idempotent: when the registry already holds <chart>:<version>, it must hold exactly these chart files; then nothing
# is pushed, the signature is applied again, and the published package becomes the canonical one. Different contents
# fail the release instead of overwriting a published version. Prints `digest=sha256:...` and `tgz=<canonical package>`
# on stdout and in $GITHUB_OUTPUT when set; the Helm repository publishes that same package.
set -euo pipefail
export BASH_COMPAT=50

chart=${1:?usage: publish-oci.sh <chart> <version> <tgz>}
version=${2:?usage: publish-oci.sh <chart> <version> <tgz>}
tgz=${3:?usage: publish-oci.sh <chart> <version> <tgz>}
REGISTRY=${CHART_OCI_REGISTRY:-oci://ghcr.io/aient-ai/charts}
REFERENCE="${REGISTRY#oci://}/$chart"
# Rehearsal switches, for a dry run against a throwaway registry on localhost that publishes nothing:
# CHART_SIGN_KEY signs with that throwaway key and no transparency log, and CHART_OCI_PLAIN_HTTP=true talks plain
# HTTP to the registry. A release sets neither and signs keyless as COSIGN_IDENTITY; in this repository's own
# workflows the script refuses both, so a release can never sign with a throwaway key or push over plain HTTP.
if [[ ${GITHUB_REPOSITORY:-} == aient-ai/helm-charts && ( -n ${CHART_SIGN_KEY:-} || -n ${CHART_OCI_PLAIN_HTTP:-} ) ]]; then
  echo "publish-oci.sh: CHART_SIGN_KEY and CHART_OCI_PLAIN_HTTP are rehearsal switches; a release in aient-ai/helm-charts cannot set them" >&2
  exit 1
fi
SIGN_KEY=${CHART_SIGN_KEY:-}
helm_oci=()
[[ ${CHART_OCI_PLAIN_HTTP:-} != true ]] || helm_oci=(--plain-http)
[[ -n $SIGN_KEY ]] || IDENTITY=${COSIGN_IDENTITY:?the workflow identity that signs, https://github.com/<repo>/.github/workflows/<file>@<ref>}
out=${CHART_OUT_DIR:-$(dirname "$tgz")}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/local" "$work/remote"
tar -xzf "$tgz" -C "$work/local"
if pulled=$(helm pull "$REGISTRY/$chart" --version "$version" --destination "$work/remote" "${helm_oci[@]}" 2>&1); then
  mkdir -p "$work/remote/x"
  tar -xzf "$work/remote/$chart-$version.tgz" -C "$work/remote/x"
  diff -r "$work/local" "$work/remote/x" >&2 || { echo "$REFERENCE:$version is already published with other contents" >&2; exit 1; }
  echo "$REFERENCE:$version is already published with these contents; signing it again" >&2
  mkdir -p "$out/published"
  cp "$work/remote/$chart-$version.tgz" "$out/published/$chart-$version.tgz"
  tgz="$out/published/$chart-$version.tgz"
  pushed=$pulled
else
  grep -qi "not found" <<<"$pulled" || { echo "$pulled" >&2; exit 1; }
  pushed=$(helm push "$tgz" "$REGISTRY" "${helm_oci[@]}" 2>&1)
fi
digest=$(grep -o 'sha256:[0-9a-f]\{64\}' <<<"$pushed" | head -1)
[[ -n $digest ]] || { echo "no digest in: $pushed" >&2; exit 1; }

# Signing the same digest again only adds a signature, so a rerun converges.
if [[ -n $SIGN_KEY ]]; then
  cosign sign --yes --key "$SIGN_KEY" --tlog-upload=false --use-signing-config=false "$REFERENCE@$digest"
  cosign verify "$REFERENCE@$digest" --key "${SIGN_KEY%.key}.pub" --insecure-ignore-tlog=true >/dev/null
else
  cosign sign --yes "$REFERENCE@$digest"
  cosign verify "$REFERENCE@$digest" --certificate-identity "$IDENTITY" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com >/dev/null
fi
printf 'digest=%s\ntgz=%s\n' "$digest" "$tgz"
[[ -z ${GITHUB_OUTPUT:-} ]] || printf 'digest=%s\ntgz=%s\n' "$digest" "$tgz" >>"$GITHUB_OUTPUT"

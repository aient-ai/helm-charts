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
IDENTITY=${COSIGN_IDENTITY:?the workflow identity that signs, https://github.com/<repo>/.github/workflows/<file>@<ref>}
out=${CHART_OUT_DIR:-$(dirname "$tgz")}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/local" "$work/remote"
tar -xzf "$tgz" -C "$work/local"
if pulled=$(helm pull "$REGISTRY/$chart" --version "$version" --destination "$work/remote" 2>&1); then
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
  pushed=$(helm push "$tgz" "$REGISTRY" 2>&1)
fi
digest=$(grep -o 'sha256:[0-9a-f]\{64\}' <<<"$pushed" | head -1)
[[ -n $digest ]] || { echo "no digest in: $pushed" >&2; exit 1; }

# Signing the same digest again only adds a signature, so a rerun converges.
cosign sign --yes "$REFERENCE@$digest"
cosign verify "$REFERENCE@$digest" --certificate-identity "$IDENTITY" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com >/dev/null
printf 'digest=%s\ntgz=%s\n' "$digest" "$tgz"
[[ -z ${GITHUB_OUTPUT:-} ]] || printf 'digest=%s\ntgz=%s\n' "$digest" "$tgz" >>"$GITHUB_OUTPUT"

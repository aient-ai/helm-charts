#!/usr/bin/env bash
# Install the release workflow's tools for linux/amd64 into <dir>, each pinned by version and SHA-256 in the workflow's
# env (HELM_*, COSIGN_*, GITSIGN_*, TRIVY_*, KUSTOMIZE_*), and put <dir> on the job's PATH.
#
#   install-tools.sh <dir> <helm|cosign|gitsign|trivy|kustomize>...
set -euo pipefail
export BASH_COMPAT=50

dir=${1:?usage: install-tools.sh <dir> <tool>...}
shift
mkdir -p "$dir"
download() { # url sha256 file
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 "$1" --output "$3"
  printf '%s  %s\n' "$2" "$3" | sha256sum --check --strict --quiet -
}
for tool in "$@"; do
  archive="$dir/$tool.download"
  case "$tool" in
    helm)
      download "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" "$HELM_SHA256" "$archive"
      tar -xzf "$archive" -C "$dir" --strip-components=1 linux-amd64/helm ;;
    cosign)
      download "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/${COSIGN_BINARY}" "$COSIGN_SHA256" "$archive"
      install -m 0555 "$archive" "$dir/cosign" ;;
    gitsign)
      download "https://github.com/sigstore/gitsign/releases/download/${GITSIGN_VERSION}/gitsign_${GITSIGN_VERSION#v}_linux_amd64" "$GITSIGN_SHA256" "$archive"
      install -m 0555 "$archive" "$dir/gitsign" ;;
    trivy)
      download "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz" "$TRIVY_SHA256" "$archive"
      tar -xzf "$archive" -C "$dir" trivy ;;
    kustomize)
      download "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2F${KUSTOMIZE_VERSION}/kustomize_${KUSTOMIZE_VERSION}_linux_amd64.tar.gz" "$KUSTOMIZE_SHA256" "$archive"
      tar -xzf "$archive" -C "$dir" kustomize ;;
    *) echo "unknown tool: $tool" >&2; exit 2 ;;
  esac
  rm -f "$archive"
done
[[ -z ${GITHUB_PATH:-} ]] || echo "$dir" >>"$GITHUB_PATH"

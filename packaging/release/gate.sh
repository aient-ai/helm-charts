#!/usr/bin/env bash
# The release gate's image check for one chart: every image its values pin by digest must be signed by the release
# workflow packaging/<chart>/release.env names (its full identity, since the chart is released from another repository
# than the images), and Trivy must find no fixable critical vulnerability in it.
#
#   gate.sh <chart>
set -euo pipefail
export BASH_COMPAT=50

chart=${1:?usage: gate.sh <chart>}
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=/dev/null
source "$REPO/packaging/$chart/release.env"

images=$(yq -r '.. | select(type == "!!map" and has("repository") and has("digest")) | .repository + ":" + .tag + "@" + .digest' \
  "$REPO/packaging/$chart/helm/values.yaml")
[[ -n $images ]] || { echo "packaging/$chart/helm/values.yaml pins no image" >&2; exit 1; }
for image in $images; do
  repository=${image%%:*} tag=${image#*:} digest=${image##*@}
  tag=${tag%@*}
  signer=
  for entry in "${IMAGE_SIGNERS[@]}"; do [[ ${entry%%=*} == "$repository" ]] && signer=${entry#*=}; done
  [[ -n $signer ]] || { echo "$repository has no signer in packaging/$chart/release.env" >&2; exit 1; }
  cosign verify "$repository@$digest" --certificate-identity "$signer$tag" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com >/dev/null
  trivy image --quiet --severity CRITICAL --ignore-unfixed --exit-code 1 "$repository@$digest"
  echo "$repository@$digest: signed by $signer$tag; no fixable critical vulnerability"
done

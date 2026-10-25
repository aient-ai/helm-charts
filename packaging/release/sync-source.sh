#!/usr/bin/env bash
# Copy the Helm charts' release sources from this repository's HEAD to the `source` branch of the public repository
# github.com/aient-ai/helm-charts, whose own release workflow (packaging/release/public-repo/release.yml) builds and
# publishes from them. Run only by .github/workflows/sync-helm-charts-source.yml.
#
#   sync-source.sh
#
# The branch holds, at their paths here: for each chart packaging/<chart>/{helm,kustomize,release.env} and
# tests/quality/<chart>-packaging-contract.test.mjs, and packaging/release plus the modules the contract tests import.
# Each commit is signed keyless with gitsign (release-git.sh); the release workflow accepts only commits signed by this
# repository's sync workflow on main, so the deploy key alone cannot feed it a release.
#
# Idempotent: when the branch already holds this tree, nothing is pushed. Prints `commit=<sha>` on stdout and in
# $GITHUB_OUTPUT when set.
set -euo pipefail
export BASH_COMPAT=50

# Self-hosted runners reach the internet only on TCP 443, so SSH uses GitHub's port-443 endpoint.
REMOTE=${HELM_CHARTS_REPO_URL:-ssh://git@ssh.github.com:443/aient-ai/helm-charts.git}
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=packaging/release/release-git.sh
source "$REPO/packaging/release/release-git.sh"
# What the contract tests import outside packaging/; a missing one fails the test that runs them from the synced tree.
SUPPORT=(
  infra/k8s-identity/aient-viewer/generate.mjs
  infra/k8s-identity/aient-viewer/policy.yaml
  tests/quality/helpers/require-helm.mjs
  tests/quality/helpers/temp-directory-cleanup.mjs
  tests/quality/run-bounded.mjs
  scripts/lib/directory-cleanup.mjs
)

head=$(git -C "$REPO" rev-parse HEAD)
paths=(packaging/release "${SUPPORT[@]}")
for chart_file in "$REPO"/packaging/*/helm/Chart.yaml; do
  chart=$(basename "$(dirname "$(dirname "$chart_file")")")
  paths+=("packaging/$chart/helm" "packaging/$chart/kustomize" "packaging/$chart/release.env"
    "tests/quality/$chart-packaging-contract.test.mjs")
done
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

release_git_init "$work/source" "$REMOTE"
cd "$work/source"
git checkout -q --orphan source
if git fetch -q helm-charts source 2>/dev/null; then git reset -q --hard FETCH_HEAD; fi
git rm -r -q --cached --ignore-unmatch . && git clean -q -fdx
git -C "$REPO" archive "$head" -- "${paths[@]}" | tar -x
git add -- .
if git rev-parse -q --verify HEAD >/dev/null && [[ $(git rev-parse 'HEAD^{tree}') == $(git write-tree) ]]; then
  echo "source already holds the tree of $head" >&2
else
  git commit -q -m "Release sources from ${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-haf/glimt}@$head"
  git push -q helm-charts HEAD:refs/heads/source
fi
commit=$(git rev-parse HEAD)
echo "commit=$commit"
[[ -z ${GITHUB_OUTPUT:-} ]] || echo "commit=$commit" >>"$GITHUB_OUTPUT"

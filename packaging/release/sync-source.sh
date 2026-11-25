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
# Files the contract tests read by path rather than import; a missing one fails the test that runs them from the
# synced tree. The modules they import are found by following the imports (imported_modules), not listed here.
DATA=(
  infra/k8s-identity/aient-viewer/policy.yaml
)

# Prints each repository-relative module reachable from the given ones through static relative imports
# (`from './x.mjs'`, `import '../y.mjs'`), the given ones included. A list kept by hand went stale when a contract
# test gained a helper import, and the release ran without it.
imported_modules() {
  local -A seen=()
  local queue=("$@") file spec segment
  while ((${#queue[@]})); do
    file=${queue[0]}
    queue=("${queue[@]:1}")
    [[ -z ${seen[$file]:-} ]] || continue
    seen[$file]=1
    [[ -f $REPO/$file ]] || { echo "sync-source: $file is imported but missing" >&2; return 1; }
    echo "$file"
    while IFS= read -r spec; do
      local parts=() out=()
      IFS=/ read -r -a parts <<<"$(dirname "$file")/$spec"
      for segment in "${parts[@]}"; do
        case $segment in
          '' | .) ;;
          ..) unset 'out[${#out[@]}-1]' ;;
          *) out+=("$segment") ;;
        esac
      done
      queue+=("$(IFS=/; echo "${out[*]}")")
    done < <(grep -oE "(from|^import) +['\"]\.{1,2}/[^'\"]+['\"]" "$REPO/$file" | sed -E "s/^(from|import) +['\"]//; s/['\"]\$//")
  done
}

head=$(git -C "$REPO" rev-parse HEAD)
paths=(packaging/release "${DATA[@]}")
tests=()
for chart_file in "$REPO"/packaging/*/helm/Chart.yaml; do
  chart=$(basename "$(dirname "$(dirname "$chart_file")")")
  paths+=("packaging/$chart/helm" "packaging/$chart/kustomize" "packaging/$chart/release.env")
  tests+=("tests/quality/$chart-packaging-contract.test.mjs")
done
modules=$(imported_modules "${tests[@]}")
mapfile -t modules <<<"$modules"
paths+=("${modules[@]}")
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

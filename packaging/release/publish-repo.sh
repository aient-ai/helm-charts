#!/usr/bin/env bash
# Publish one chart release to the public repository github.com/aient-ai/helm-charts. Run only by that repository's
# release workflow, packaging/release/public-repo/release.yml.
#
#   publish-repo.sh <chart> <version> <packaged .tgz> [<file published next to the package>...]
#
# main: charts/<chart> (the chart's source) and kustomize/<chart> (its Kustomize tree) from packaging/<chart>, and
#   README.md and LICENSE (Apache-2.0) from packaging/release; other charts' directories are left as they are.
# gh-pages: the Helm repository GitHub Pages serves, https://aient-ai.github.io/helm-charts: the package, the files
#   given after it (its signature and provenance bundles), and index.yaml with this version merged in.
# Tag <chart>-<version> on the main commit. Commits and tag are signed keyless with gitsign, and the two branches and
# the tag are pushed atomically, so an interrupted run publishes nothing. The main commit names $RELEASE_SOURCE, the
# source commit it was built from.
#
# Idempotent: when the tag exists, its chart and Kustomize trees and the published package must equal these, and
# nothing is pushed; different contents fail instead of overwriting a published version.
# Prints `commit=<sha>` on stdout and in $GITHUB_OUTPUT when set.
set -euo pipefail
export BASH_COMPAT=50

chart=${1:?usage: publish-repo.sh <chart> <version> <tgz> [file...]}
version=${2:?usage: publish-repo.sh <chart> <version> <tgz> [file...]}
tgz=${3:?usage: publish-repo.sh <chart> <version> <tgz> [file...]}
shift 3
extras=("$@")
REMOTE=${HELM_CHARTS_REPO_URL:-git@github.com:aient-ai/helm-charts.git}
PAGES_URL=${HELM_CHARTS_PAGES_URL:-https://aient-ai.github.io/helm-charts}
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=packaging/release/release-git.sh
source "$REPO/packaging/release/release-git.sh"
source_dir="$REPO/packaging/$chart"
package="$chart-$version.tgz"
tag="$chart-$version"
[[ -d $source_dir/helm && -d $source_dir/kustomize ]] || { echo "no chart $chart in packaging/" >&2; exit 1; }
tgz=$(cd "$(dirname "$tgz")" && pwd)/$(basename "$tgz")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

same_package() { # published.tgz
  mkdir -p "$work/a" "$work/b" && rm -rf "$work/a/"* "$work/b/"*
  tar -xzf "$tgz" -C "$work/a" && tar -xzf "$1" -C "$work/b" && diff -r "$work/a" "$work/b" >&2
}

# main: this chart's directories replaced, everything else kept.
release_git_init "$work/main" "$REMOTE"
cd "$work/main"
if git fetch -q helm-charts main 2>/dev/null; then git reset -q --hard FETCH_HEAD; fi
git rm -r -q --ignore-unmatch "charts/$chart" "kustomize/$chart" README.md LICENSE
mkdir -p charts kustomize
cp -R "$source_dir/helm" "charts/$chart"
cp -R "$source_dir/kustomize" "kustomize/$chart"
cp "$REPO/packaging/release/public-repo/README.md" README.md
cp "$REPO/packaging/release/public-repo/LICENSE" LICENSE
git add -- "charts/$chart" "kustomize/$chart" README.md LICENSE
chart_tree=$(git write-tree --prefix="charts/$chart/")
kustomize_tree=$(git write-tree --prefix="kustomize/$chart/")

if git fetch -q helm-charts "refs/tags/$tag:refs/tags/$tag" 2>/dev/null; then
  [[ $(git rev-parse "$tag:charts/$chart") == "$chart_tree" && $(git rev-parse "$tag:kustomize/$chart") == "$kustomize_tree" ]] \
    || { echo "$tag already exists with other contents" >&2; exit 1; }
  git fetch -q helm-charts gh-pages
  git show "FETCH_HEAD:$package" >"$work/published.tgz" || { echo "$tag exists but gh-pages has no $package" >&2; exit 1; }
  same_package "$work/published.tgz" || { echo "gh-pages holds another $package" >&2; exit 1; }
  commit=$(git rev-parse "$tag^{commit}")
  echo "$tag already published as $commit" >&2
else
  if ! git rev-parse -q --verify HEAD >/dev/null || [[ $(git rev-parse 'HEAD^{tree}') != $(git write-tree) ]]; then
    git commit -q -m "$chart $version" -m "From ${RELEASE_SOURCE:-${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-haf/glimt}@${GITHUB_SHA:-$(git -C "$REPO" rev-parse HEAD)}}."
  fi
  commit=$(git rev-parse HEAD)
  git tag -a "$tag" -m "$chart $version" "$commit"

  # gh-pages: the package and its files, and the index with this version merged in.
  release_git_init "$work/pages" "$REMOTE"
  git -C "$work/pages" checkout -q --orphan gh-pages
  if git -C "$work/pages" fetch -q helm-charts gh-pages 2>/dev/null; then git -C "$work/pages" reset -q --hard FETCH_HEAD; fi
  if [[ -f $work/pages/$package ]]; then
    same_package "$work/pages/$package" || { echo "gh-pages holds another $package" >&2; exit 1; }
  else
    cp "$tgz" "$work/pages/$package"
  fi
  for file in "${extras[@]}"; do cp "$file" "$work/pages/"; done
  mkdir -p "$work/index"
  cp "$work/pages/$package" "$work/index/"
  [[ -f $work/pages/index.yaml ]] && merge=(--merge "$work/pages/index.yaml") || merge=()
  # Indexing only the new package keeps every existing entry, including its created time, unchanged.
  helm repo index "$work/index" --url "$PAGES_URL" "${merge[@]}"
  cp "$work/index/index.yaml" "$work/pages/index.yaml"
  touch "$work/pages/.nojekyll"
  git -C "$work/pages" add -- .
  git -C "$work/pages" commit -q -m "$chart $version"
  git fetch -q "$work/pages" gh-pages:refs/heads/gh-pages

  git push -q --atomic helm-charts "$commit:refs/heads/main" refs/heads/gh-pages:refs/heads/gh-pages "refs/tags/$tag"
fi
echo "commit=$commit"
[[ -z ${GITHUB_OUTPUT:-} ]] || echo "commit=$commit" >>"$GITHUB_OUTPUT"

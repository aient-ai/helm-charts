#!/usr/bin/env bash
# pinned-download.sh SHA256 URL DEST         place the file whose content has SHA256 at DEST
# pinned-download.sh --pins FILE --dest DIR  place every pin of FILE for this platform in DIR
#
# The one way CI fetches a pinned release asset (.github/actions/pinned-download wraps it with the Actions cache;
# tests/quality/pinned-download-contract.test.mjs keeps every other CI path from fetching one directly). A file is
# looked up by its SHA-256 in PINNED_DOWNLOAD_CACHE (default ~/.cache/aient/pinned-downloads) and copied out when
# present and intact; otherwise it is downloaded once, verified, and stored there for the next caller.
#
# A pins FILE has one pin per line, `<sha256> <https url> <name> [<os>-<arch>]`; `#` starts a comment. A line with a
# platform applies only there (`linux-amd64`, `darwin-arm64`, ...), so one file serves CI and a workstation. A
# script that downloads at run time keeps its pins in such a file, and its workflow primes the Actions cache from the
# same file (the action's pins-file input), so the script's own calls are cache hits.
#
# A failed download is not retried: GitHub's release-asset edge answered 504 to our runners in whole windows
# (2026-11-05, docs/plans/2026-11-02-feat-ci-runner-rightsizing-plan.md), and a retry inside the window only waits
# longer. The failure prints the response headers once, so the answering edge is named.
#
# Idempotent: rerunning after success copies the cached file again; an interrupted download leaves only a temporary
# file, which the next run replaces.
set -euo pipefail

usage() { echo "usage: $0 SHA256 URL DEST | $0 --pins FILE --dest DIR" >&2; exit 64; }

platform() {
  local os arch
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "$arch" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; esac
  printf '%s-%s\n' "$os" "$arch"
}

digest() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

place() {
  local sha256=$1 url=$2 dest=$3
  [[ "$sha256" =~ ^[0-9a-f]{64}$ ]] || { echo "pinned-download: not a SHA-256: $sha256" >&2; exit 64; }
  [[ "$url" == https://* ]] || { echo "pinned-download: not an https URL: $url" >&2; exit 64; }
  local cache=${PINNED_DOWNLOAD_CACHE:-${HOME:-/tmp}/.cache/aient/pinned-downloads}
  local cached="$cache/$sha256"
  mkdir -p "$cache" "$(dirname "$dest")"
  if [ -f "$cached" ] && [ "$(digest "$cached")" = "$sha256" ]; then
    echo "pinned-download: cache hit $sha256 ($url)" >&2
  else
    local part headers actual
    part=$(mktemp "$cache/.part.XXXXXX")
    headers=$(mktemp "$cache/.headers.XXXXXX")
    echo "pinned-download: cache miss $sha256, downloading $url" >&2
    if ! curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
        --connect-timeout 20 --max-time 600 --dump-header "$headers" --output "$part" "$url"; then
      echo "pinned-download: download failed for $url; response headers:" >&2
      sed 's/^/  /' "$headers" >&2
      rm -f "$part" "$headers"
      exit 1
    fi
    rm -f "$headers"
    actual=$(digest "$part")
    if [ "$actual" != "$sha256" ]; then
      rm -f "$part"
      echo "pinned-download: $url has SHA-256 $actual, pinned $sha256" >&2
      exit 1
    fi
    mv -f "$part" "$cached"
  fi
  cp -f "$cached" "$dest"
}

if [ "${1:-}" = --pins ]; then
  [ "$#" -eq 4 ] && [ "$3" = --dest ] || usage
  file=$2 dir=$4 here=$(platform) placed=0
  while read -r sha256 url name only _; do
    case "$sha256" in ''|'#'*) continue ;; esac
    [ -n "$name" ] || { echo "pinned-download: $file: a pin has no name: $sha256" >&2; exit 64; }
    [ -z "$only" ] || [ "$only" = "$here" ] || continue
    place "$sha256" "$url" "$dir/$name"
    placed=$((placed + 1))
  done < "$file"
  [ "$placed" -gt 0 ] || { echo "pinned-download: $file has no pin for $here" >&2; exit 1; }
  exit 0
fi

[ "$#" -eq 3 ] || usage
place "$1" "$2" "$3"

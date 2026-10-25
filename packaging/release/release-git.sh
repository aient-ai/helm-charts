# Sourced by publish-repo.sh and sync-source.sh.
#
# release_git_init <dir> <url>: a new repository in <dir> with the remote helm-charts at <url>, committing as Aient
# release. Not `origin`: an Aient sandbox sets remote.origin.url for every repository through GIT_CONFIG_* variables.
# Commits and tags are signed keyless with gitsign unless $HELM_CHARTS_SIGN is `none` (tests only): Sigstore certifies
# the running workflow's OIDC identity, and the signature is logged in Rekor.
release_git_init() {
  git init -q -b main "$1"
  git -C "$1" remote add helm-charts "$2"
  git -C "$1" config user.name "Aient release"
  git -C "$1" config user.email "release@aient.ai"
  case "${HELM_CHARTS_SIGN:-gitsign}" in
    gitsign)
      git -C "$1" config gpg.format x509
      git -C "$1" config gpg.x509.program gitsign
      git -C "$1" config commit.gpgsign true
      git -C "$1" config tag.gpgsign true ;;
    none) ;;
    *) echo "HELM_CHARTS_SIGN is gitsign or none (tests only)" >&2; return 1 ;;
  esac
}

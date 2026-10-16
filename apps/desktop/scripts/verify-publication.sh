#!/usr/bin/env bash
set -euo pipefail
repo=${1:?Pass an explicitly selected sandbox owner/repo}
source_repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
if [ "$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$source_repo" | tr '[:upper:]' '[:lower:]')" ]; then
  echo 'Publication verification must use a separate sandbox repository.'
  exit 1
fi
target=$(gh api "repos/$repo/commits/HEAD" --jq .sha)
work=$(mktemp -d)
export GH_REPO="$repo" RELEASE_TARGET="$target" GITHUB_REPOSITORY="$source_repo" RELEASE_LATEST=false
export DESKTOP_VERSION="0.0.0-verify.$(date +%s).$$" RELEASE_TAG_PREFIX=desktop-test-v
tag="$RELEASE_TAG_PREFIX$DESKTOP_VERSION"
cleanup() {
  gh release delete "$tag" --cleanup-tag --yes || true
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/assets" "$work/download"
printf 'publication verification\n' > "$work/assets/probe.txt"
printf 'Temporary desktop publication verification.\n' > "$work/notes.md"
bash apps/desktop/scripts/publish-release.sh "$work/assets" "$work/notes.md"
gh release view "$tag" --json isDraft --jq .isDraft | python3 -c 'import sys; assert sys.stdin.read().strip() == "false"'
gh release download "$tag" --dir "$work/download"
cmp "$work/assets/probe.txt" "$work/download/probe.txt"
printf 'must not overwrite\n' > "$work/assets/probe.txt"
bash apps/desktop/scripts/publish-release.sh "$work/assets" "$work/notes.md"
gh release download "$tag" --dir "$work/download" --clobber
test "$(cat "$work/download/probe.txt")" = 'publication verification'
gh release delete "$tag" --cleanup-tag --yes
if gh api "repos/$repo/git/ref/tags/$tag" >/dev/null 2>&1; then
  echo 'Sandbox tag cleanup failed.'
  exit 1
fi
trap 'rm -rf "$work"' EXIT
echo 'Sandbox create, upload, publish, download, idempotent retry, and cleanup passed.'

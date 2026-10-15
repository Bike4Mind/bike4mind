#!/usr/bin/env bash
set -euo pipefail
: "${GH_REPO:?}" "${DESKTOP_VERSION:?}" "${RELEASE_TARGET:?}" "${GITHUB_REPOSITORY:?}"
if [ "$(printf %s "$GH_REPO" | tr '[:upper:]' '[:lower:]')" = "$(printf %s "$GITHUB_REPOSITORY" | tr '[:upper:]' '[:lower:]')" ]; then
  echo 'Distribution must not use the source repository.'
  exit 1
fi
tag="${RELEASE_TAG_PREFIX:-desktop-v}$DESKTOP_VERSION"
assets=${1:?Installer directory required}
notes=${2:?Release notes required}
state=$(gh api "repos/$GH_REPO/releases?per_page=100" --paginate --jq ".[] | select(.tag_name == \"$tag\") | .draft")
if [ "$state" = false ]; then
  echo "Release $tag is already published; leaving assets unchanged."
  exit 0
fi
if [ -z "$state" ]; then
  gh release create "$tag" --target "$RELEASE_TARGET" --draft --title "Bike4Mind Desktop $DESKTOP_VERSION" --notes-file "$notes"
fi
gh release upload "$tag" "$assets"/* --clobber
# Verify the uploaded bytes before making either manifest publicly reachable.
download=$(mktemp -d)
trap 'rm -rf "$download"' EXIT
gh release download "$tag" --dir "$download"
test "$(printf '%s\n' "$assets"/* | wc -l)" = "$(printf '%s\n' "$download"/* | wc -l)" || { echo 'Unexpected remote asset set'; exit 1; }
for asset in "$assets"/*; do cmp "$asset" "$download/$(basename "$asset")"; done
gh release edit "$tag" --draft=false "--latest=${RELEASE_LATEST:-true}"
gh release view "$tag" --json isDraft,assets --jq '{isDraft,assets:[.assets[].name]}'

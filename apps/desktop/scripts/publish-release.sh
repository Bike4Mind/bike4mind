#!/usr/bin/env bash
set -euo pipefail
: "${GH_REPO:?}" "${DESKTOP_VERSION:?}" "${RELEASE_TARGET:?}"
tag="${RELEASE_TAG_PREFIX:-desktop-v}$DESKTOP_VERSION"
assets=${1:?Installer directory required}
notes=${2:?Release notes required}
state=$(gh api "repos/$GH_REPO/releases?per_page=100" --paginate --jq ".[] | select(.tag_name == \"$tag\") | .draft")
if [ "$state" = false ]; then
  echo "Release $tag is already published; leaving assets unchanged."
  exit 0
fi
if [ -z "$state" ]; then
  gh release create "$tag" --target "$RELEASE_TARGET" --draft --title "Desktop $DESKTOP_VERSION" --notes-file "$notes"
fi
gh release upload "$tag" "$assets"/* --clobber
gh release edit "$tag" --draft=false --latest=false
gh release view "$tag" --json isDraft,assets --jq '{isDraft,assets:[.assets[].name]}'

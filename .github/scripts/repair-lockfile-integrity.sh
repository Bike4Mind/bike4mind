#!/usr/bin/env bash
# Restores the integrity hash on bare `resolution: {tarball: URL}` entries in a
# pnpm lockfile, copying `{integrity: ..., tarball: URL}` for the identical URL
# from a trusted base lockfile. Pure text substitution: no network, no install.
# Used by .github/workflows/dependabot-lockfile-repair.yml; the guard it feeds is
# the grep in .github/workflows/lockfile-integrity.yml.
#
# The pattern anchors on `{tarball:` as the first key, so git-hosted entries
# (`{gitHosted: true, tarball: ...}`) never match.
#
# Exit 0: every bare entry was restored (or there were none).
# Exit 1: some URL has no hashed entry in the base lockfile; each one is printed
#         to stderr and left bare for a human to resolve.
#
# Usage: repair-lockfile-integrity.sh <pr-lockfile> <base-lockfile>

set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <pr-lockfile> <base-lockfile>" >&2
  exit 2
fi
pr=$1
base=$2

# An empty base would make awk read the PR lockfile as the base (NR == FNR).
if [ ! -s "$base" ] || [ ! -f "$pr" ]; then
  echo "missing or empty lockfile: $pr / $base" >&2
  exit 2
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

rc=0
awk '
  NR == FNR {
    if (match($0, /resolution: \{integrity: [^,}]+, tarball: [^}]+\}/)) {
      s = substr($0, RSTART, RLENGTH)
      url = s
      sub(/^.*, tarball: /, "", url)
      sub(/\}$/, "", url)
      hashed[url] = s
    }
    next
  }
  match($0, /resolution: \{tarball: [^}]+\}/) {
    # 22 = length("resolution: {tarball: "); the trailing "}" is dropped too.
    url = substr($0, RSTART + 22, RLENGTH - 23)
    # substr rather than sub(): a "&" in the URL would be read as the match.
    if (url in hashed) {
      $0 = substr($0, 1, RSTART - 1) hashed[url] substr($0, RSTART + RLENGTH)
    } else {
      print url > "/dev/stderr"
      missing = 1
    }
  }
  { print }
  END { exit missing }
' "$base" "$pr" >"$tmp" || rc=$?

# Write in place (not mv) so the lockfile keeps its mode.
cat "$tmp" >"$pr"
exit "$rc"

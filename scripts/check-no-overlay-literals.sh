#!/usr/bin/env bash
# Fails when a tracked file (content or path) matches the overlay-literal pattern
# and is not on the temporary allowlist in scripts/overlay-literals-allowlist.txt.
#
# The pattern is stored base64-encoded so this script, the allowlist and any
# test do not themselves contain the literals.
#
# The allowlist is explicit and temporary: it may only shrink. An entry that no
# longer matches is also an error, so removals must be reflected in the list.
# Entries are exact paths, or `re:<ERE>` for a full-path regex; blank lines and
# lines starting with # are ignored.
#
# Usage: check-no-overlay-literals.sh [--list]
#   --list  print every tracked path that currently matches, one per line

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

PATTERN_B64='KFtvT11bcFBdW3RUXVtpSV1baEhdW2FBXVtzU11baEhdW2lJXXxbcVFdW3VVXVthQV1bbk5dW3RUXVt1VV1bbU1dfFtpSV1bb09dW25OXVtxUV0oW15hLXpdfCQpfFtxUV1bdVVdW2JCXVtvT118W3FRXVthQV1bb09dW2FBXSk='
PATTERN=$(printf '%s' "$PATTERN_B64" | base64 -d)
ALLOWLIST="scripts/overlay-literals-allowlist.txt"

all_matches() {
  {
    git grep -lIE -e "$PATTERN" -- . || true
    git ls-files | grep -E -e "$PATTERN" || true
  } | sort -u
}

if [ "${1:-}" = "--list" ]; then
  all_matches
  exit 0
fi

patterns=()
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '' | '#'*) continue ;; esac
  patterns+=("$line")
done < "$ALLOWLIST"

entry_matches() {
  case "$1" in
    're:'*) [[ "$2" =~ ^(${1#re:})$ ]] ;;
    *) [ "$1" = "$2" ] ;;
  esac
}

allowed() {
  local p
  for p in ${patterns[@]+"${patterns[@]}"}; do
    entry_matches "$p" "$1" && return 0
  done
  return 1
}

violations=""
matches=$(all_matches)
while IFS= read -r path; do
  [ -z "$path" ] && continue
  allowed "$path" || violations+="$path"$'\n'
done <<< "$matches"

stale=""
for p in ${patterns[@]+"${patterns[@]}"}; do
  hit=0
  while IFS= read -r path; do
    entry_matches "$p" "$path" && { hit=1; break; }
  done <<< "$matches"
  [ "$hit" -eq 0 ] && stale+="$p"$'\n'
done

status=0
if [ -n "$violations" ]; then
  echo "ERROR: tracked files match the overlay-literal pattern and are not allowlisted:"
  printf '%s' "$violations" | sed 's/^/  /'
  echo ""
  echo "Remove the literal from these files. Do not extend $ALLOWLIST."
  status=1
fi
if [ -n "$stale" ]; then
  echo "ERROR: $ALLOWLIST has entries that no longer match anything:"
  printf '%s' "$stale" | sed 's/^/  /'
  echo ""
  echo "Delete these entries so the allowlist keeps shrinking."
  status=1
fi
if [ "$status" -eq 0 ]; then
  echo "No unallowlisted overlay literals in tracked files."
fi
exit "$status"

#!/usr/bin/env bash
# Fail if two tracked paths differ in letter casing. Linux CI treats them as distinct files, but
# on case-insensitive filesystems (default macOS/Windows checkouts) they collide: TypeScript's
# consistent-casing check fails and so does the pre-push hook, which Linux CI can never catch.
#
# Module specifiers omit the extension, so the comparison drops a trailing script extension:
# Foo.tsx and foo.ts collide, but index.d.cts and index.d.mts (same casing) do not.
set -euo pipefail

if ! paths="$(git ls-files)"; then
  echo "check-no-case-collisions: git ls-files failed." >&2
  exit 1
fi

collisions="$(
  printf '%s\n' "$paths" |
    awk '{
      stem = $0
      sub(/\.(tsx?|mts|cts|jsx?|mjs|cjs)$/, "", stem)
      key = tolower(stem)
      if ((key in seen) && seen[key] != stem) { print first[key]; print $0 }
      else { seen[key] = stem; first[key] = $0 }
    }' |
    sort -u
)"

if [ -n "$collisions" ]; then
  echo "check-no-case-collisions: tracked paths differ only in casing:" >&2
  printf '%s\n' "$collisions" | sed 's/^/  /' >&2
  echo "Rename one so the paths are distinct on a case-insensitive filesystem." >&2
  exit 1
fi

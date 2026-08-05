#!/usr/bin/env bash
# Fail if a .ts/.tsx file contains a raw control byte (NUL and friends). A raw NUL makes
# git/GitHub treat the file as binary, so grep/rg silently return nothing and the diff is
# unviewable in the PR UI. See #1221 / PR #1367.
#
# Modes (one script, one pattern = single source of truth):
#   (default) / --staged   staged .ts/.tsx only, for the husky pre-commit hook.
#   --changed <base>       files added/modified vs <base>, for CI so a `--no-verify`
#                          bypass is still caught. Falls back to --all when <base> is
#                          missing or unresolvable, so an unknown base over-scans rather
#                          than silently checking nothing.
#   --all                  every tracked .ts/.tsx.
#
# Uses perl, NOT `grep -P`, for two verified reasons:
#   1. macOS ships BSD grep, which has no -P (PCRE) flag at all.
#   2. Even GNU grep needs -a to match a NUL: without it grep treats the file as
#      binary and skips the match, missing the exact worst case this guard exists for.
# perl -0777 reads each file as raw bytes and matches reliably on every platform.
#
# Fails closed: a missing or erroring perl exits non-zero rather than reporting "clean".
set -euo pipefail

# C0 controls except tab (09), LF (0a), CR (0d); plus DEL (7f).
pattern='[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]'

if ! command -v perl >/dev/null 2>&1; then
  echo "check-no-control-bytes: perl not found, cannot scan for control bytes." >&2
  exit 1
fi

all_cmd=(git ls-files -- '*.ts' '*.tsx')

case "${1:-}" in
  --all)
    list_cmd=("${all_cmd[@]}")
    ;;
  --changed)
    base="${2:-}"
    if [ -n "$base" ] && git rev-parse --verify --quiet "${base}^{commit}" >/dev/null 2>&1; then
      list_cmd=(git diff --name-only --diff-filter=ACM "${base}...HEAD" -- '*.ts' '*.tsx')
    else
      echo "check-no-control-bytes: base '${base}' unresolvable, scanning all tracked files." >&2
      list_cmd=("${all_cmd[@]}")
    fi
    ;;
  *)
    list_cmd=(git diff --cached --name-only --diff-filter=ACM -- '*.ts' '*.tsx')
    ;;
esac

# Plain read loop (not mapfile/readarray) so this runs on macOS's bash 3.2. The -f test
# skips paths git lists but the worktree lacks (e.g. a staged deletion under --all), which
# would otherwise make perl warn about a file there is nothing to scan.
files=()
while IFS= read -r f; do [ -f "$f" ] && files+=("$f"); done < <("${list_cmd[@]}")
[ ${#files[@]} -eq 0 ] && exit 0

set +e
hits=$(perl -0777 -ne "print \"\$ARGV\\n\" if /$pattern/" "${files[@]}")
perl_status=$?
set -e
if [ "$perl_status" -ne 0 ]; then
  echo "check-no-control-bytes: perl exited ${perl_status}, failing closed." >&2
  exit 1
fi

if [ -n "$hits" ]; then
  echo "Raw control bytes found in:"
  echo "$hits"
  echo "Replace them with escape sequences (e.g. \\x00, \\x7f), or build the byte at"
  echo "runtime (String.fromCharCode), so the files stay ASCII and greppable."
  exit 1
fi

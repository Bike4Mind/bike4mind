#!/usr/bin/env bash
# Fail if a .ts/.tsx file contains a raw control byte (NUL and friends). A raw NUL makes
# git/GitHub treat the file as binary, so grep/rg silently return nothing and the diff is
# unviewable in the PR UI. See #1221 / PR #1367.
#
# Modes (one script, one pattern = single source of truth):
#   (default) / --staged   staged .ts/.tsx only, for the husky pre-commit hook. Reads the
#                          STAGED BLOB, not the worktree copy, so editing a file after
#                          `git add` cannot hide a bad blob that is about to be committed.
#   --changed <base>       files added/modified vs <base>, for CI so a `--no-verify` bypass
#                          is still caught. Falls back to --all when <base> is missing or
#                          unresolvable, so an unknown base over-scans rather than silently
#                          scanning nothing.
#   --all                  every tracked .ts/.tsx.
#
# Uses perl, NOT `grep -P`, for two verified reasons:
#   1. macOS ships BSD grep, which has no -P (PCRE) flag at all.
#   2. Even GNU grep needs -a to match a NUL: without it grep treats the file as
#      binary and skips the match, missing the exact worst case this guard exists for.
#
# SECURITY: filenames are fed to perl on stdin (NUL-separated) and opened with a 3-argument
# `open`. They must NEVER reach @ARGV: perl's -n wraps the body in `while (<>)`, and the
# diamond operator does a magic 2-argument open on each @ARGV element, so a tracked file
# merely NAMED `|cmd.ts` would execute `cmd`. That is code execution triggered by the same
# careless-contributor case this guard exists to catch. A bare `--` does not help -- it stops
# perl's own switch parsing, not the diamond operator's runtime behaviour.
#
# Fails closed: a missing or erroring perl, and a failing git listing, both exit non-zero
# rather than reporting "clean".
set -euo pipefail

# C0 controls except tab (09), LF (0a), CR (0d); plus DEL (7f).
CB_PATTERN='[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]'
export CB_PATTERN

if ! command -v perl >/dev/null 2>&1; then
  echo "check-no-control-bytes: perl not found, cannot scan for control bytes." >&2
  exit 1
fi

# -z keeps paths raw and NUL-separated. Without it git applies core.quotePath and emits
# non-ASCII paths C-style-quoted (e.g. "caf\303\251.ts"), which no longer names a real file.
all_cmd=(git ls-files -z -- '*.ts' '*.tsx')
staged=

case "${1:-}" in
  --all)
    list_cmd=("${all_cmd[@]}")
    ;;
  --changed)
    base="${2:-}"
    if [ -n "$base" ] && git rev-parse --verify --quiet "${base}^{commit}" >/dev/null 2>&1; then
      list_cmd=(git diff --name-only -z --diff-filter=ACM "${base}...HEAD" -- '*.ts' '*.tsx')
    else
      echo "check-no-control-bytes: base '${base}' unresolvable, scanning all tracked files." >&2
      list_cmd=("${all_cmd[@]}")
    fi
    ;;
  ''|--staged)
    list_cmd=(git diff --cached --name-only -z --diff-filter=ACM -- '*.ts' '*.tsx')
    staged=1
    ;;
  *)
    echo "check-no-control-bytes: unknown option '$1'" >&2
    echo "usage: check-no-control-bytes.sh [--staged | --changed <base> | --all]" >&2
    exit 1
    ;;
esac
export CB_STAGED="$staged"

# Piped, not `< <(...)`: process substitution exit codes are invisible to set -e/pipefail, so
# a failing git listing would yield an empty list and a bogus "clean" pass. In a pipeline
# pipefail sees it. A non-zero pipeline here therefore means the scan did not complete, which
# is treated as a failure rather than a pass.
if ! hits=$(
  "${list_cmd[@]}" | perl -0 -ne '
    my $f = $_;
    $f =~ s/\0\z//;
    next if $f eq "";
    my $fh;
    if ($ENV{CB_STAGED}) {
      # List form: no shell, so a path cannot be interpreted as a command.
      open($fh, "-|", "git", "show", ":$f") or exit 3;
    } else {
      # A path git lists but the worktree lacks (an unstaged deletion under --all) has
      # nothing to scan; skip it rather than let perl warn.
      next unless -f $f;
      open($fh, "<", $f) or exit 3;
    }
    binmode($fh);
    my $data = do { local $/; <$fh> };
    close($fh) or exit 3;
    print "$f\n" if defined($data) && $data =~ /$ENV{CB_PATTERN}/;
  '
); then
  echo "check-no-control-bytes: file listing or scan failed, failing closed." >&2
  exit 1
fi

if [ -n "$hits" ]; then
  echo "Raw control bytes found in:"
  echo "$hits"
  echo "Replace them with escape sequences (e.g. \\x00, \\x7f), or build the byte at"
  echo "runtime (String.fromCharCode), so the files stay ASCII and greppable."
  exit 1
fi

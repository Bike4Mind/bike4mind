#!/usr/bin/env bash
# Fail if an ADDED line in a TypeScript source file (.ts/.tsx/.mts/.cts) contains smart
# punctuation (curly quotes, em/en dashes). This is the second half of the CLAUDE.md ASCII-only
# rule; the first half (raw control bytes) is scripts/check-no-control-bytes.sh. See #1458 / #1385.
#
# Why a script at all: an em-dash and a hyphen are a pixel apart in most editors, so this is a
# rule humans cannot enforce by reading a diff.
#
# Modes (mirrors check-no-control-bytes.sh so the two read as one family):
#   (default) / --staged   staged changes, for the husky pre-commit hook. `git diff --cached`
#                          is by construction the staged blob, so editing a file after
#                          `git add` cannot hide what is about to be committed.
#   --changed <base>       changes vs <base>, for CI so a `--no-verify` bypass is still
#                          caught. Falls back to --all when <base> is missing or unresolvable,
#                          so an unknown base over-scans rather than silently scanning nothing.
#   --all                  every tracked source file, whole contents. NOT wired into the hook or
#                          CI: ~645 files on main already carry smart punctuation, so this mode
#                          is for measurement and for a future cleanup, not for gating.
#
# LINE-level, not file-level -- the one real difference from the control-byte guard, and it is
# load-bearing. Measured on main at 93f4b774: scanning whole changed files would have failed 37
# of the last 54 .ts/.tsx-touching commits (because 645 tracked files already contain an
# em-dash), while scanning only added lines flags 8 lines across the last 60 commits. Hence
# `-U0`: with any context at all, a pre-existing em-dash sitting a few lines from an unrelated
# edit would fail the commit.
#
# Every mode is the same code path: parse a unified diff, look only at added lines. --all gets
# there by diffing against the empty tree, which presents every tracked file as all-added.
#
# Anything that makes git call the file BINARY would otherwise blind this guard completely: git
# emits "Binary files ... differ" with no +++ or @@ records, so the scan sees nothing and exits 0
# on a real violation. Two routes reach that state -- a NUL byte in the content, and a tracked
# `.gitattributes` line such as `*.ts -diff`, which needs no NUL and no malice. `--text` in DIFF
# below forces a readable body in both cases, so this guard stands on its own rather than relying
# on check-no-control-bytes.sh to catch the cause. (The sibling guard would not have backstopped
# the .gitattributes route anyway: it only looks for control bytes, and an em-dash is not one.)
#
# Fails closed: a missing or erroring perl, and a failing git diff, both exit non-zero rather
# than reporting "clean".
set -euo pipefail

if ! command -v perl >/dev/null 2>&1; then
  echo "check-no-smart-punctuation: perl not found, cannot scan for smart punctuation." >&2
  exit 1
fi

# Neutralise git config that silently breaks diff parsing. diff.noprefix=true emits `+++ path`
# and diff.mnemonicPrefix=true emits `+++ w/path`, either of which would make this script parse
# no filenames and pass everything -- a false clean, which is the worst failure a guard has.
# diff.srcPrefix/dstPrefix (git 2.39+) shift the prefix instead of removing it, which only
# corrupts the reported path, but a report naming a file that does not exist is its own bug.
# core.quotePath=false keeps non-ASCII paths readable in the report. Unknown keys are ignored by
# older git, so pinning all five is safe.
GIT=(git -c core.quotePath=false -c diff.noprefix=false -c diff.mnemonicPrefix=false
     -c diff.srcPrefix=a/ -c diff.dstPrefix=b/)

# No --diff-filter: an added line can only come from a record that has one (a deletion diffs to
# `+++ /dev/null`), and omitting the filter means no record shape -- R rename, C copy, T
# typechange -- can be silently dropped. Dropping R is the exact bug that bit the control-byte
# guard, so this guard avoids needing the filter at all.
# --no-ext-diff/--no-textconv: a configured external differ or textconv filter would rewrite the
# diff body out from under the parser.
# --text is load-bearing, not cosmetic: without it a binary-classified file (NUL content, or a
# `*.ts -diff` line in a tracked .gitattributes) produces no diff body at all and the guard exits 0
# on a real violation. See the note above.
DIFF=(-U0 --text --no-ext-diff --no-textconv)
# .mts/.cts are included even though only one is tracked today: the cost is zero (added lines
# only) and a new module-syntax file should not arrive unguarded.
PATHSPEC=('*.ts' '*.tsx' '*.mts' '*.cts')

usage() {
  echo "usage: check-no-smart-punctuation.sh [--staged | --changed <base> | --all]" >&2
}

all_diff() {
  # The empty tree, so every tracked file's whole content shows up as added lines. hash-object
  # without -w only computes the id, it writes nothing. Fed from empty stdin rather than
  # /dev/null: identical result (4b825dc6...) without assuming /dev/null is readable.
  local empty_tree
  if ! empty_tree=$(printf '' | "${GIT[@]}" hash-object --stdin -t tree 2>/dev/null); then
    echo "check-no-smart-punctuation: cannot resolve the empty tree object." >&2
    return 1
  fi
  "${GIT[@]}" diff "${DIFF[@]}" "$empty_tree" -- "${PATHSPEC[@]}"
}

case "${1:-}" in
  --all)
    diff_fn=all_diff
    ;;
  --changed)
    base="${2:-}"
    if [ -n "$base" ] && git rev-parse --verify --quiet "${base}^{commit}" >/dev/null 2>&1; then
      changed_diff() { "${GIT[@]}" diff "${DIFF[@]}" "${base}...HEAD" -- "${PATHSPEC[@]}"; }
      diff_fn=changed_diff
    else
      echo "check-no-smart-punctuation: base '${base}' unresolvable, scanning all tracked files." >&2
      diff_fn=all_diff
    fi
    ;;
  ''|--staged)
    staged_diff() { "${GIT[@]}" diff --cached "${DIFF[@]}" -- "${PATHSPEC[@]}"; }
    diff_fn=staged_diff
    ;;
  *)
    echo "check-no-smart-punctuation: unknown option '$1'" >&2
    usage
    exit 1
    ;;
esac

# Piped, not `< <(...)`: process substitution exit codes are invisible to set -e/pipefail, so a
# failing git diff would yield an empty diff and a bogus "clean" pass. In a pipeline pipefail
# sees it, and a non-zero pipeline here is treated as a failed scan rather than a pass.
#
# The diff arrives on stdin and perl is given NO file arguments, so no path ever reaches @ARGV.
# That matters: perl's diamond operator does a magic 2-argument open on @ARGV entries, so a file
# merely NAMED `|cmd.ts` would execute `cmd`. Keep it this way -- a refactor toward opening files
# by name reintroduces that hazard (see the SECURITY note in check-no-control-bytes.sh).
if ! hits=$(
  "$diff_fn" | perl -e '
    # The six characters of the rule, keyed by their third UTF-8 byte: all of U+2013, U+2014,
    # U+2018, U+2019, U+201C and U+201D share the prefix \xe2\x80. Matched as RAW BYTES on
    # purpose -- a \x{2014} pattern silently matches NOTHING unless the input was decoded, which
    # is a quiet false pass, and adding a :utf8 layer would instead warn on any malformed UTF-8
    # in the diff. One map drives both detection and the report, so they cannot drift.
    my %LABEL = (
      "\x93" => "U+2013 en-dash",       "\x94" => "U+2014 em-dash",
      "\x98" => "U+2018 left quote",    "\x99" => "U+2019 right quote",
      "\x9c" => "U+201C left dquote",   "\x9d" => "U+201D right dquote",
    );
    my $class = "[" . join("", sort keys %LABEL) . "]";
    my $RE = qr/\xe2\x80$class/;

    # Parsed as a state machine, NOT by matching header shapes anywhere in the stream. An ADDED
    # line whose content starts with "++ " reaches us as "+++ ...", which reads exactly like a
    # file header: with the content "++ /dev/null" that blanks the current path and every later
    # added line in the file gets skipped, i.e. a silent clean pass -- the worst failure a guard
    # can have, and reachable from any .ts holding a diff as a fixture or docs string. So a
    # header is only recognised between `diff --git` and the first `@@` of that file, and nothing is
    # treated as content until a hunk has started. Metadata and content can no longer be
    # confused in either direction.
    my ($path, $lineno, $in_hunk);
    while (my $line = <STDIN>) {
      if ($line =~ /^diff --git /) {
        ($path, $lineno, $in_hunk) = (undef, undef, 0);
        next;
      }
      if (!$in_hunk && $line =~ m{^\+\+\+ (.*)$}) {
        my $p = $1;
        $p =~ s/\r?\n\z//;
        # A git-quoted path (embedded tab/quote/newline) is reported verbatim; it is only ever
        # printed, never opened, so the quoting is cosmetic.
        $p =~ s{^b/}{};
        $path = $p eq "/dev/null" ? undef : $p;
        next;
      }
      # @@ -old,n +new,n @@ : the new-file line number is where the added run starts. Deleted
      # lines do not advance it, and with -U0 there are no context lines to account for.
      if ($line =~ /^\@\@ -\d+(?:,\d+)? \+(\d+)/) {
        $lineno = $1;
        $in_hunk = 1;
        next;
      }
      next unless $in_hunk;
      next unless $line =~ s/^\+//;
      next unless defined $path;
      my $at = defined $lineno ? $lineno++ : 0;
      next unless $line =~ $RE;
      $line =~ s/\r?\n\z//;
      # Replace the offending bytes with their names: the whole problem is that these characters
      # are invisible, so echoing the raw line back would not tell anyone where to look.
      $line =~ s/\xe2\x80($class)/"[" . $LABEL{$1} . "]"/ge;
      printf "%s:%s: %s\n", $path, $at, $line;
    }
  '
); then
  echo "check-no-smart-punctuation: diff or scan failed, failing closed." >&2
  exit 1
fi

if [ -n "$hits" ]; then
  echo "Smart punctuation found in added lines:"
  echo "$hits"
  echo
  echo "CLAUDE.md requires ASCII in TypeScript sources: use - for dashes and ' \" for quotes."
  echo "If a typographic character is genuinely wanted in a user-facing string, write it as an"
  echo "escape (e.g. '\\u2014') so it stays visible in review and greppable."
  exit 1
fi

#!/usr/bin/env bash
# Fail if a commit carries the SHAPE of a leak: a path that should never reach this public
# repository, or an added line holding a cloud identifier that must be resolved at runtime.
# Companion to scripts/check-no-smart-punctuation.sh and scripts/check-no-control-bytes.sh,
# and to the Restricted Terms workflow, which checks the same list but only after a push,
# which on a public repository is after publication.
#
# Scope: EVERY staged path, whatever its extension, read from the staged blob (or the diff),
# never from the worktree copy.
#
# Path rules (the new path of every added, modified, renamed, copied or type-changed file):
#   - anything under docs/superpowers/ or .codex/ (local planning artifacts, never tracked)
#   - a root-level *.html (one-off audit pages land there)
#   - the local term file itself
#   - a path matching a restricted term
#
# Content rules (ADDED lines only, in --staged and --changed mode):
#   - an AWS ARN that names a concrete resource: one carrying a 12-digit account id, or an
#     S3 ARN with a literal bucket name (ARNs built from a template placeholder pass)
#   - a 12-digit number that is not a placeholder: a single repeated digit, the AWS
#     documentation account ids (123456789012, 111122223333) or 987654321098, the set
#     docs-site/scripts/check-docs-content.mjs already treats as placeholders
#   - a public IPv4 address with at least one multi-digit octet: anything outside RFC 1918,
#     loopback, link-local, RFC 5737 documentation ranges, 192.0.0.0/24, 0/8, CGNAT and
#     multicast/reserved space (four single-digit octets is a section number or a placeholder)
#   - a fully formed Slack incoming-webhook URL (hooks.slack.com/services/T.../B.../token)
#   - a restricted term
#
# Restricted terms come from an OPTIONAL, git-ignored file at the repo root,
# .restricted-terms.local: one case-insensitive regex per line, blank lines and # comments
# skipped, matched on word boundaries exactly as scripts/check-restricted-terms.mjs matches
# the RESTRICTED_TERMS list in CI. The file is the same list, copied from the private tracker;
# it is never printed, and neither is any matched text. A hit reports only the path, the
# line number and WHICH rule fired, so the report is safe in a public CI log.
#
# Allowlist: scripts/leak-shapes-allowlist.txt, one extended regex per line, # comments and
# blank lines skipped. A content hit is dropped when a pattern matches "<path>:<line>", a
# path hit when a pattern matches "<path>". Add an entry with a comment saying why the
# match is legitimate (a fixture, a documentation example, a vendor-published value).
#
# Modes (mirrors the sibling guards):
#   (default) / --staged   staged changes, for the husky pre-commit hook.
#   --changed <base>       changes vs <base>, for CI so a `--no-verify` bypass is still
#                          caught. Falls back to --all when <base> is missing or
#                          unresolvable, so an unknown base over-scans rather than silently
#                          scanning nothing.
#   --all                  every tracked file, whole contents, by diffing against the empty
#                          tree. For measurement and for seeding the allowlist.
#
# Fails closed: a missing or erroring perl, a failing git listing or diff, and an invalid
# allowlist or term regex all exit non-zero rather than reporting "clean".
set -euo pipefail

NAME=check-no-leak-shapes
ALLOWLIST=scripts/leak-shapes-allowlist.txt
TERMS_FILE=.restricted-terms.local

if ! command -v perl >/dev/null 2>&1; then
  echo "$NAME: perl not found, cannot scan." >&2
  exit 1
fi

# Same git pinning as the sibling guards: a diff.noprefix or mnemonicPrefix setting would
# make the header parser see no filenames and pass everything.
GIT=(git -c core.quotePath=false -c diff.noprefix=false -c diff.mnemonicPrefix=false
     -c diff.srcPrefix=a/ -c diff.dstPrefix=b/)
DIFF=(-U0 --text --no-ext-diff --no-textconv)

usage() {
  echo "usage: $NAME.sh [--staged | --changed <base> | --all]" >&2
}

empty_tree() {
  printf '' | "${GIT[@]}" hash-object --stdin -t tree
}

all_paths() { "${GIT[@]}" ls-files -z; }
all_diff() {
  local tree
  if ! tree=$(empty_tree 2>/dev/null); then
    echo "$NAME: cannot resolve the empty tree object." >&2
    return 1
  fi
  "${GIT[@]}" diff "${DIFF[@]}" "$tree"
}

# --diff-filter=d (lowercase) EXCLUDES deletions and keeps every other record shape, so a
# rename, copy or typechange is never dropped. --name-only emits the NEW path for R/C.
mode=staged
case "${1:-}" in
  --all)
    mode=all
    paths_fn=all_paths
    diff_fn=all_diff
    ;;
  --changed)
    base="${2:-}"
    if [ -n "$base" ] && git rev-parse --verify --quiet "${base}^{commit}" >/dev/null 2>&1; then
      mode=changed
      changed_paths() { "${GIT[@]}" diff --name-only -z --diff-filter=d "${base}...HEAD"; }
      changed_diff() { "${GIT[@]}" diff "${DIFF[@]}" "${base}...HEAD"; }
      paths_fn=changed_paths
      diff_fn=changed_diff
    else
      echo "$NAME: base '${base}' unresolvable, scanning all tracked files." >&2
      mode=all
      paths_fn=all_paths
      diff_fn=all_diff
    fi
    ;;
  ''|--staged)
    staged_paths() { "${GIT[@]}" diff --cached --name-only -z --diff-filter=d; }
    staged_diff() { "${GIT[@]}" diff --cached "${DIFF[@]}"; }
    paths_fn=staged_paths
    diff_fn=staged_diff
    ;;
  *)
    echo "$NAME: unknown option '$1'" >&2
    usage
    exit 1
    ;;
esac

if [ ! -f "$ALLOWLIST" ]; then
  echo "$NAME: allowlist not found at $ALLOWLIST" >&2
  exit 1
fi

# Both lists travel to perl through the environment, never as arguments or file names, so no
# shell and no magic open ever sees their contents.
export LS_ALLOWLIST
LS_ALLOWLIST=$(grep -vE '^[[:space:]]*(#|$)' "$ALLOWLIST" || true)
export LS_TERMS=
export LS_HAVE_TERMS=0
if [ -f "$TERMS_FILE" ]; then
  LS_TERMS=$(grep -vE '^[[:space:]]*(#|$)' "$TERMS_FILE" || true)
  LS_HAVE_TERMS=1
fi
export LS_TERMS_FILE="$TERMS_FILE"
export LS_ALLOWLIST_PATH="$ALLOWLIST"
export LS_MODE="$mode"

# Shared by both scans. Compiles the lists (exit 4 on a bad regex, so a typo in the allowlist
# fails the run instead of silently allowing nothing or everything) and defines the matchers.
PERL_COMMON='
  use strict; use warnings;
  use Unicode::Normalize qw(NFD NFKC);
  our (@ALLOW, @TERMS, $WORD_EDGE);
  # The same fold as check-restricted-terms.mjs, applied to every term and every subject, so a
  # fullwidth letter, a zero-width joiner or an accent cannot hide a term from this guard
  # when CI would still see it. Compatibility mapping can leave a combining mark behind, so
  # the strip runs twice.
  sub fold {
    my $s = NFD(shift);
    $s =~ s/[\p{Cf}\p{Mn}]//g;
    $s = NFKC($s);
    $s =~ s/[\p{Cf}\p{Mn}]//g;
    return $s;
  }
  sub compile_list {
    my ($raw, $what, $bounded) = @_;
    my @out;
    for my $line (split /\r?\n/, $raw) {
      $line =~ s/^\s+|\s+$//g;
      next if $line eq "" || $line =~ /^#/;
      my $src = $line;
      utf8::decode($src);
      $src = fold($src) if $bounded;
      my $re = eval {
        $bounded ? qr/$WORD_EDGE(?:$src)$WORD_EDGE/iu : qr/$src/u
      };
      if (!defined $re) { print STDERR "'"$NAME"': invalid regex in $what list.\n"; exit 4; }
      if ("" =~ $re) { print STDERR "'"$NAME"': a $what pattern matches the empty string.\n"; exit 4; }
      push @out, $re;
    }
    return @out;
  }
  # Word edges as check-restricted-terms.mjs defines them: a term matches inside term_helper,
  # term-cli and useTermClient but not inside termination. Case-sensitive edges around a
  # case-insensitive fragment.
  $WORD_EDGE = q{(?-i:(?<![\p{L}\p{N}])|(?![\p{L}\p{N}])|(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L}))};
  @ALLOW = compile_list($ENV{LS_ALLOWLIST}, "allowlist", 0);
  @TERMS = compile_list($ENV{LS_TERMS}, "restricted-term", 1);
  sub decoded { my $s = shift; my $c = $s; utf8::decode($c) or return $s; return $c; }
  sub allowed { my $subject = decoded(shift); for my $re (@ALLOW) { return 1 if $subject =~ $re } return 0; }
  sub has_term { my $s = fold(decoded(shift)); for my $re (@TERMS) { return 1 if $s =~ $re } return 0; }
'

# --- Path scan ------------------------------------------------------------------------------
# NUL-separated paths on stdin, never on @ARGV (see the SECURITY note in
# check-no-control-bytes.sh: the diamond operator would execute a path named `|cmd`).
if ! path_hits=$(
  "$paths_fn" | perl -0 -e "$PERL_COMMON"'
    my $terms_file = $ENV{LS_TERMS_FILE};
    while (my $p = <STDIN>) {
      $p =~ s/\0\z//;
      next if $p eq "";
      # Checked first, before any rule that would echo the path: a path that is itself the
      # problem is withheld whatever else it matches, and it is never allowlisted.
      if (has_term($p)) { print "<path withheld>: restricted term in path\n"; next; }
      my $why;
      if    ($p =~ m{^docs/superpowers/})  { $why = "local planning artifact (docs/superpowers/)" }
      elsif ($p =~ m{^\.codex/})           { $why = "local agent artifact (.codex/)" }
      elsif ($p =~ m{^[^/]+\.html\z}i)     { $why = "root-level HTML page" }
      elsif ($p eq $terms_file)            { $why = "the local restricted-term file" }
      next unless defined $why;
      next if allowed($p);
      print "$p: $why\n";
    }
  '
); then
  echo "$NAME: path listing or scan failed, failing closed." >&2
  exit 1
fi

# --- Content scan ---------------------------------------------------------------------------
# Same unified-diff state machine as check-no-smart-punctuation.sh: a header is only
# recognised between `diff --git` and the first `@@`, so an added line that happens to start
# with "++ " cannot blank the current path.
if ! content_hits=$(
  "$diff_fn" | perl -e "$PERL_COMMON"'
    my $allowlist_path = $ENV{LS_ALLOWLIST_PATH};
    # An ARN naming a concrete resource: an account field that is not a documented placeholder,
    # or an S3 ARN whose bucket name is a literal rather than a template/glob placeholder.
    # A literal bucket name ends at a quote, a slash, whitespace, a comma or a bracket; anything
    # else after the name (a glob `*`, a `[region]` or `${var}` placeholder) is not a literal.
    # Only S3 takes the empty-account branch: IAM, Route 53 and CloudFront policy resources
    # (a hosted-zone or distribution wildcard) leave region and account empty by design.
    my $ARN = qr{\barn:aws[a-z-]*:(?:[a-z0-9-]*:[a-z0-9-]*:([0-9]{12}):|s3:::[a-z0-9][a-z0-9.-]*(?=[/"\x27\x60,)\]\s]|\z))};
    # Bounded so a UUID segment, a hyphenated or dotted number and a hex run do not count.
    my $ACCOUNT = qr{(?<![0-9A-Za-z_-])(?<![0-9]\.)([0-9]{12})(?![0-9A-Za-z_-])(?!\.[0-9])};
    # Not after "<letter>/": that is a product/version token (Chrome/120.0.0.0) in a user-agent
    # string. A URL host follows "//", so http://<address> is still scanned.
    my $IPV4 = qr{(?<![0-9A-Za-z_.])(?<![A-Za-z]/)((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?![0-9A-Za-z_.])};
    # A fully formed incoming-webhook URL (workspace, channel and token segments), not the host
    # or a placeholder: settings copy and egress allowlists name the host.
    my $SLACK = qr{hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]{16,}};
    sub public_ipv4 {
      my @o = split /\./, shift;
      return 0 if grep { $_ > 255 } @o;
      # Four single-digit octets is a section number (4.1.2.1), a placeholder (1.2.3.4) or a
      # public resolver (8.8.8.8, 1.1.1.1), never an address worth hiding.
      return 0 unless grep { $_ > 9 } @o;
      my ($a, $b, $c) = @o;
      return 0 if $a == 0 || $a == 10 || $a == 127;
      return 0 if $a == 100 && $b >= 64 && $b <= 127;
      return 0 if $a == 169 && $b == 254;
      return 0 if $a == 172 && $b >= 16 && $b <= 31;
      return 0 if $a == 192 && $b == 168;
      return 0 if $a == 192 && $b == 0 && ($c == 0 || $c == 2);
      return 0 if $a == 198 && ($b == 18 || $b == 19);
      return 0 if $a == 198 && $b == 51 && $c == 100;
      return 0 if $a == 203 && $b == 0 && $c == 113;
      return 0 if $a >= 224;
      return 1;
    }
    # Placeholders: one repeated digit (000000000000, 111111111111), the two AWS documentation
    # account ids, and 987654321098, which docs-site/scripts/check-docs-content.mjs also treats
    # as a placeholder.
    sub sensitive_account {
      my $n = shift;
      return 0 if $n =~ /^([0-9])\1{11}\z/;
      return 0 if $n eq "123456789012" || $n eq "111122223333" || $n eq "987654321098";
      return 1;
    }
    sub sensitive_arn {
      my $line = shift;
      while ($line =~ /$ARN/g) {
        my $account = $1;
        return 1 if !defined $account || sensitive_account($account);
      }
      return 0;
    }
    my ($path, $lineno, $in_hunk);
    while (my $line = <STDIN>) {
      if ($line =~ /^diff --git /) { ($path, $lineno, $in_hunk) = (undef, undef, 0); next; }
      if (!$in_hunk && $line =~ m{^\+\+\+ (.*)$}) {
        # git appends a TAB to the header of a name containing a space.
        my $p = $1; $p =~ s/\r?\n\z//; $p =~ s/\t\z//; $p =~ s{^b/}{};
        $path = $p eq "/dev/null" ? undef : $p;
        next;
      }
      if ($line =~ /^\@\@ -\d+(?:,\d+)? \+(\d+)/) { $lineno = $1; $in_hunk = 1; next; }
      next unless $in_hunk;
      next unless $line =~ s/^\+//;
      next unless defined $path;
      my $at = defined $lineno ? $lineno++ : 0;
      # The allowlist is made of patterns describing these very shapes, so the address rule
      # (which a pattern like 10\.0\. would trip) is skipped there. The identifier and term
      # rules still run and are never allowlisted for it: silencing a value by pasting it into
      # the allowlist would publish that value.
      my $in_allowlist = $path eq $allowlist_path;
      # A NUL marks binary content (fonts, images) forced through --text; the identifier rules
      # are meaningless on it.
      next if index($line, "\0") >= 0;
      $line =~ s/\r?\n\z//;
      my @why;
      push @why, "AWS ARN"           if sensitive_arn($line);
      push @why, "12-digit account id" if grep { sensitive_account($_) } ($line =~ /$ACCOUNT/g);
      push @why, "public IPv4 address" if !$in_allowlist && grep { public_ipv4($_) } ($line =~ /$IPV4/g);
      push @why, "Slack webhook URL"   if $line =~ $SLACK;
      my $term = has_term($line);
      # The allowlist covers the built-in shapes only; a restricted term is never allowlisted,
      # exactly as in CI.
      @why = () if @why && !$in_allowlist && allowed("$path:$line");
      push @why, "restricted term" if $term;
      next unless @why;
      my $shown = has_term($path) ? "<path withheld>" : $path;
      print "$shown:$at: ", join(", ", @why), "\n";
    }
  '
); then
  echo "$NAME: diff or scan failed, failing closed." >&2
  exit 1
fi

if [ "$LS_HAVE_TERMS" = 0 ]; then
  if [ "$mode" = staged ]; then
    echo "$NAME: no $TERMS_FILE at the repo root, so only the built-in shapes were checked." >&2
    echo "  Create it (it is git-ignored) with one case-insensitive regex per line, copied from" >&2
    echo "  the RESTRICTED_TERMS list kept in the private tracker; ask a maintainer for it." >&2
  else
    echo "$NAME: no $TERMS_FILE, restricted-term rules skipped." >&2
  fi
fi

if [ -n "$path_hits" ] || [ -n "$content_hits" ]; then
  if [ -n "$path_hits" ]; then
    echo "Paths that must not be committed to this public repository:"
    echo "$path_hits"
    echo
  fi
  if [ -n "$content_hits" ]; then
    echo "Leak shapes found in added lines (path:line: rule; matched text is not shown):"
    echo "$content_hits"
    echo
  fi
  echo "Resolve cloud identifiers at runtime (env, SSM, SST links) instead of committing them,"
  echo "and keep local planning artifacts and audit pages out of the index. Write a large numeric"
  echo "constant with separators (100_000_000_000) so it does not read as an account id. If a"
  echo "match is a fixture or documentation example, add a commented pattern to $ALLOWLIST,"
  echo "matching the path, never the value."
  exit 1
fi

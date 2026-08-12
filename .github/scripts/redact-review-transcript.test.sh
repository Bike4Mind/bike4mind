#!/usr/bin/env bash
# Self-test for redact-review-transcript.py.
# Usage: bash .github/scripts/redact-review-transcript.test.sh
#
# This script is the only thing between the private bot-review skill body and a
# world-downloadable artifact on a public repo, and the workflow that runs it
# only ever executes against real PRs. So the fail-closed paths are pinned here.

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REDACTOR="$SCRIPT_DIR/redact-review-transcript.py"

PASSED=0
FAILED=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

SKILL="$TMP/skill.md"
cat >"$SKILL" <<'EOF'
# bot-review

Always start by reading the full diff and the linked issue before commenting.
Classify every finding as P0, P1, P2 or P3 and justify the severity you pick.
Prefer a data-testid selector like "modal-confirm-btn" over any CSS class name.
short line
EOF

EMPTY_SKILL="$TMP/empty-skill.md"
printf 'short\ntiny\n' >"$EMPTY_SKILL"

DEST="$TMP/out.json"
RC=0
OUT=""

# run <transcript-file> [skill-file] -- sets RC and OUT (dest contents, empty if absent)
run() {
  rm -f "$DEST"
  python3 "$REDACTOR" "$1" "${2:-$SKILL}" "$DEST" >/dev/null 2>"$TMP/stderr"
  RC=$?
  OUT=""
  [ -f "$DEST" ] && OUT=$(cat "$DEST")
  return 0
}

pass() {
  echo "ok: $1"
  PASSED=$((PASSED + 1))
}

fail() {
  echo "FAIL: $1 -- $2"
  echo "  stderr: $(cat "$TMP/stderr")"
  FAILED=$((FAILED + 1))
}

# check_rc <name> <want-rc>
check_rc() {
  if [ "$RC" -eq "$2" ]; then return 0; fi
  fail "$1" "exit $RC, wanted $2"
  return 1
}

# no_dest <name> -- fail-closed: nothing may be written when redaction is refused
no_dest() {
  if [ ! -f "$DEST" ]; then return 0; fi
  fail "$1" "destination file was written despite a refusal"
  return 1
}

# absent <name> <needle>
absent() {
  case "$OUT" in
    *"$2"*) fail "$1" "leaked: $2"; return 1 ;;
  esac
  return 0
}

# present <name> <needle>
present() {
  case "$OUT" in
    *"$2"*) return 0 ;;
  esac
  fail "$1" "missing from output: $2"
  return 1
}

# --- a whole skill body arriving as a line-numbered Read tool_result ---------
cat >"$TMP/bulk.json" <<'EOF'
[{"type":"user","message":{"content":[{"type":"tool_result","content":"     1\t# bot-review\n     2\tAlways start by reading the full diff and the linked issue before commenting.\n     3\tClassify every finding as P0, P1, P2 or P3 and justify the severity you pick.\n"}]}},
 {"type":"assistant","num_turns":12,"message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"gh pr diff 1"}}]}}]
EOF
NAME='bulk Read tool_result is redacted, diagnostics kept'
run "$TMP/bulk.json"
check_rc "$NAME" 0 &&
  absent "$NAME" 'Always start by reading' &&
  absent "$NAME" 'justify the severity' &&
  present "$NAME" 'redacted: bot-review skill content' &&
  present "$NAME" 'num_turns' &&
  present "$NAME" 'Bash' &&
  present "$NAME" 'gh pr diff 1' &&
  pass "$NAME"

# --- a skill line split across two adjacent JSON strings --------------------
cat >"$TMP/split.json" <<'EOF'
[{"type":"assistant","message":{"content":[
  {"type":"text","text":"Always start by reading the full diff and th"},
  {"type":"text","text":"e linked issue before commenting on the code."}]}}]
EOF
NAME='needle split across two strings is caught'
run "$TMP/split.json"
check_rc "$NAME" 0 &&
  absent "$NAME" 'Always start by reading the full diff and th' &&
  absent "$NAME" 'e linked issue before commenting' &&
  pass "$NAME"

# --- a needle containing a double quote (JSON-escaped in the output) ---------
cat >"$TMP/quoted.json" <<'EOF'
[{"type":"assistant","message":{"content":[{"type":"text","text":"The skill says: Prefer a data-testid selector like \"modal-confirm-btn\" over any CSS class name."}]}}]
EOF
NAME='quoted needle does not evade the scrub'
run "$TMP/quoted.json"
check_rc "$NAME" 0 &&
  absent "$NAME" 'modal-confirm-btn' &&
  pass "$NAME"

# --- a needle sitting in a dict key: refuse rather than mangle the structure --
cat >"$TMP/key.json" <<'EOF'
[{"Classify every finding as P0, P1, P2 or P3 and justify the severity you pick.":"note"}]
EOF
NAME='needle in a dict key refuses the upload'
run "$TMP/key.json"
check_rc "$NAME" 1 && no_dest "$NAME" && pass "$NAME"

# --- JSONL, plus all three credential shapes --------------------------------
cat >"$TMP/creds.jsonl" <<'EOF'
{"type":"system","token":"ghs_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"}
{"type":"system","token":"github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234"}
{"type":"system","token":"sk-ant-api03-AbCdEfGhIjKlMnOp","tool":"Grep"}
EOF
NAME='JSONL credentials are scrubbed, tool names kept'
run "$TMP/creds.jsonl"
check_rc "$NAME" 0 &&
  absent "$NAME" 'ghs_AbCdEf' &&
  absent "$NAME" 'github_pat_11ABCDEFG' &&
  absent "$NAME" 'sk-ant-api03' &&
  present "$NAME" 'redacted: credential' &&
  present "$NAME" 'Grep' &&
  pass "$NAME"

# --- degenerate inputs all fail closed --------------------------------------
NAME='unreadable skill file refuses the upload'
run "$TMP/bulk.json" "$TMP/does-not-exist.md"
check_rc "$NAME" 1 && no_dest "$NAME" && pass "$NAME"

NAME='skill with no long lines refuses the upload'
run "$TMP/bulk.json" "$EMPTY_SKILL"
check_rc "$NAME" 1 && no_dest "$NAME" && pass "$NAME"

printf 'not json at all\n' >"$TMP/garbage.txt"
NAME='transcript that is neither JSON nor JSONL refuses the upload'
run "$TMP/garbage.txt"
check_rc "$NAME" 1 && no_dest "$NAME" && pass "$NAME"

NAME='wrong argument count is a usage error'
rm -f "$DEST"
python3 "$REDACTOR" "$TMP/bulk.json" >/dev/null 2>"$TMP/stderr"
RC=$?
check_rc "$NAME" 2 && no_dest "$NAME" && pass "$NAME"

echo
echo "passed: $PASSED  failed: $FAILED"
[ "$FAILED" -eq 0 ]

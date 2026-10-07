#!/usr/bin/env bash
# Integration self-test for .github/scripts/generate-changeset.sh (the "Generate
# changeset" step of .github/workflows/auto-changeset.yml) and verify-changeset.sh.
#
# The scripts run for real against a throwaway git repo with a local bare remote, so
# `git commit`/`git push` and the merge-base diff behave as they do on a runner. `gh` is
# stubbed.
#
# Usage: bash .github/scripts/auto-changeset.test.sh

set -uo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
STEP="$REPO_ROOT/.github/scripts/generate-changeset.sh"
VERIFY="$REPO_ROOT/.github/scripts/verify-changeset.sh"
BOT_NAME="b4m-release-bot[bot]"

PASSED=0
FAILED=0

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# --- Stub gh: records invocations, reports no existing comments ---
mkdir -p "$WORK/bin"
cat >"$WORK/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_CALL_LOG"
exit 0
EOF
chmod +x "$WORK/bin/gh"

# Builds a fresh repo whose HEAD is a branch off main with the given changed files.
# Usage: make_repo <dir> <file...>
make_repo() {
  local dir="$1"
  shift

  git init --quiet --bare "$dir/origin.git"
  git clone --quiet "$dir/origin.git" "$dir/work" 2>/dev/null
  (
    cd "$dir/work"
    git config user.name "Test Dev"
    git config user.email "dev@example.com"
    git symbolic-ref HEAD refs/heads/main

    mkdir -p .changeset b4m-core/common b4m-core/auth apps/client .github/scripts
    cp "$REPO_ROOT/.github/scripts/resolve-changeset-packages.sh" .github/scripts/
    printf '%s\n' '{ "ignore": [] }' >.changeset/config.json
    printf '%s\n' '# Changesets' >.changeset/README.md
    printf '%s\n' '{ "name": "@bike4mind/common", "publishConfig": { "access": "public" } }' >b4m-core/common/package.json
    printf '%s\n' '{ "name": "@bike4mind/auth", "publishConfig": { "access": "public" } }' >b4m-core/auth/package.json
    printf '%s\n' '{ "name": "@bike4mind/client", "private": true }' >apps/client/package.json
    git add -A
    git commit --quiet -m "chore: base"
    git push --quiet origin main 2>/dev/null

    git checkout --quiet -b feature
    for f in "$@"; do
      mkdir -p "$(dirname "$f")"
      printf '%s\n' "touched" >"$f"
    done
    git add -A
    git commit --quiet -m "feat: work"
    git push --quiet -u origin feature 2>/dev/null
  )
}

# Usage: run_step <repo-work-dir> <pr-title> <pr-number>
run_step() {
  (
    cd "$1"
    PATH="$WORK/bin:$PATH" \
      GH_CALL_LOG="$1/.gh-calls" \
      PR_TITLE="$2" \
      PR_NUMBER="$3" \
      REPO="owner/repo" \
      GH_TOKEN="stub" \
      bash "$STEP" >"$1/.step-output" 2>&1
  )
}

# Usage: run_verify <repo-work-dir> <pr-title> <pr-number>; sets VERIFY_RC.
run_verify() {
  VERIFY_RC=0
  (
    cd "$1"
    PR_TITLE="$2" PR_NUMBER="$3" REPO="owner/repo" bash "$VERIFY" >"$1/.verify-output" 2>&1
  ) || VERIFY_RC=$?
}

# Usage: expect_verify <rc> <label> <repo-work-dir> <pr-title> <pr-number>
# Also asserts the verifier never pushed to the repo's real remote.
expect_verify() {
  local want="$1" label="$2" dir="$3" before
  before=$(git -C "$dir" ls-remote origin 2>/dev/null)
  run_verify "$dir" "$4" "$5"
  if [ "$VERIFY_RC" -ne "$want" ]; then
    fail "$label" "exit $VERIFY_RC, want $want:" "$(cat "$dir/.verify-output")"
  elif [ "$(git -C "$dir" ls-remote origin 2>/dev/null)" != "$before" ]; then
    fail "$label" "the verifier pushed to origin"
  else
    ok "$label"
  fi
}

ok() {
  echo "PASS: $1"
  PASSED=$((PASSED + 1))
}

fail() {
  echo "FAIL: $1"
  shift
  for line in "$@"; do echo "  $line"; done
  FAILED=$((FAILED + 1))
}

# --- The #768 regression: scope names a published package, diff touches only the app ---
D="$WORK/case-scope-only"
mkdir -p "$D"
make_repo "$D" "apps/client/src/auth/login.tsx"
run_step "$D/work" "refactor(auth): tidy the login flow" 768
if [ -f "$D/work/.changeset/pr-768.md" ]; then
  fail "scope-only PR generates no changeset" \
    "changeset was created:" "$(cat "$D/work/.changeset/pr-768.md")"
else
  ok "scope-only PR generates no changeset"
fi
if grep -q 'auto-changeset-scope-comment' "$D/work/.gh-calls" 2>/dev/null; then
  ok "scope-only PR comments on the mismatch"
else
  fail "scope-only PR comments on the mismatch" "gh calls: $(cat "$D/work/.gh-calls" 2>/dev/null)"
fi

# --- Baseline: a diff that really does touch the scoped package still bumps it ---
D="$WORK/case-real-change"
mkdir -p "$D"
make_repo "$D" "b4m-core/auth/src/index.ts"
run_step "$D/work" "fix(auth): correct token refresh" 900
if grep -q '"@bike4mind/auth": patch' "$D/work/.changeset/pr-900.md" 2>/dev/null; then
  ok "real change to the scoped package still bumps it"
else
  fail "real change to the scoped package still bumps it" \
    "output:" "$(cat "$D/work/.step-output")"
fi

# --- A package changed but not named in the scope is still bumped ---
D="$WORK/case-unscoped-change"
mkdir -p "$D"
make_repo "$D" "b4m-core/common/src/index.ts" "b4m-core/auth/src/index.ts"
run_step "$D/work" "feat(auth): new grant type" 901
if grep -q '"@bike4mind/auth": minor' "$D/work/.changeset/pr-901.md" 2>/dev/null &&
  grep -q '"@bike4mind/common": minor' "$D/work/.changeset/pr-901.md" 2>/dev/null; then
  ok "every changed package is bumped, scoped or not"
else
  fail "every changed package is bumped, scoped or not" \
    "changeset:" "$(cat "$D/work/.changeset/pr-901.md" 2>/dev/null)"
fi

# --- Deleting the auto-changeset is a durable opt-out ---
D="$WORK/case-opt-out"
mkdir -p "$D"
make_repo "$D" "b4m-core/auth/src/index.ts"
run_step "$D/work" "fix(auth): correct token refresh" 902
if [ ! -f "$D/work/.changeset/pr-902.md" ]; then
  fail "opt-out setup: first run generates a changeset" "$(cat "$D/work/.step-output")"
else
  (
    cd "$D/work"
    git rm --quiet .changeset/pr-902.md
    git commit --quiet -m "chore: drop the auto-changeset, this release needs no bump"
    git push --quiet 2>/dev/null
  )
  run_step "$D/work" "fix(auth): correct token refresh" 902
  if [ -f "$D/work/.changeset/pr-902.md" ]; then
    fail "a human-deleted changeset is not re-added" "$(cat "$D/work/.step-output")"
  else
    ok "a human-deleted changeset is not re-added"
  fi
fi

# --- The bot's own cleanup deletion must not read as an opt-out ---
D="$WORK/case-bot-deletion"
mkdir -p "$D"
make_repo "$D" "b4m-core/auth/src/index.ts"
run_step "$D/work" "fix(auth): correct token refresh" 903
(
  cd "$D/work"
  git rm --quiet .changeset/pr-903.md
  git -c "user.name=$BOT_NAME" -c "user.email=bot@example.com" \
    commit --quiet -m "chore: remove auto-changeset for PR #903 (no publishable changes)"
  git push --quiet 2>/dev/null
)
run_step "$D/work" "fix(auth): correct token refresh" 903
if [ -f "$D/work/.changeset/pr-903.md" ]; then
  ok "a bot-deleted changeset is regenerated"
else
  fail "a bot-deleted changeset is regenerated" "$(cat "$D/work/.step-output")"
fi

# --- A manual changeset still wins over auto-generation ---
D="$WORK/case-manual"
mkdir -p "$D"
make_repo "$D" "b4m-core/auth/src/index.ts"
(
  cd "$D/work"
  printf '%s\n' '---' '"@bike4mind/auth": minor' '---' '' 'Hand written.' >.changeset/hand-written.md
  git add -A
  git commit --quiet -m "chore: manual changeset"
  git push --quiet 2>/dev/null
)
run_step "$D/work" "fix(auth): correct token refresh" 904
if [ -f "$D/work/.changeset/pr-904.md" ]; then
  fail "a manual changeset suppresses auto-generation" "$(cat "$D/work/.changeset/pr-904.md")"
else
  ok "a manual changeset suppresses auto-generation"
fi

# --- A manual changeset BELOW this PR's bump level must not suppress it ---
D="$WORK/case-manual-lower"
mkdir -p "$D"
make_repo "$D" "b4m-core/auth/src/index.ts"
(
  cd "$D/work"
  printf '%s\n' '---' '"@bike4mind/auth": patch' '---' '' 'Hand written.' >.changeset/hand-written.md
  git add -A
  git commit --quiet -m "chore: manual changeset"
  git push --quiet 2>/dev/null
)
run_step "$D/work" "feat(auth): new grant type" 906
if grep -q '"@bike4mind/auth": minor' "$D/work/.changeset/pr-906.md" 2>/dev/null; then
  ok "a manual patch does not swallow this PR's minor"
else
  fail "a manual patch does not swallow this PR's minor" "output:" "$(cat "$D/work/.step-output")"
fi

# --- A hand-edited pr-<N>.md is overwritten, with a comment saying so ---
D="$WORK/case-hand-edit"
mkdir -p "$D"
make_repo "$D" "b4m-core/auth/src/index.ts"
(
  cd "$D/work"
  printf '%s\n' '---' '"@bike4mind/auth": major' '---' '' 'Hand edited.' >.changeset/pr-907.md
  git add -A
  git commit --quiet -m "chore: edit the generated changeset"
  git push --quiet 2>/dev/null
)
run_step "$D/work" "fix(auth): correct token refresh" 907
if grep -q 'looked hand-edited' "$D/work/.gh-calls" 2>/dev/null &&
  grep -q '"@bike4mind/auth": patch' "$D/work/.changeset/pr-907.md" 2>/dev/null; then
  ok "a hand-edited changeset is overwritten and reported"
else
  fail "a hand-edited changeset is overwritten and reported" \
    "changeset:" "$(cat "$D/work/.changeset/pr-907.md" 2>/dev/null)" \
    "gh calls: $(cat "$D/work/.gh-calls" 2>/dev/null)"
fi
rm -f "$D/work/.gh-calls"
run_step "$D/work" "fix(auth): correct token refresh" 907
if grep -q 'looked hand-edited' "$D/work/.gh-calls" 2>/dev/null; then
  fail "the hand-edit warning stops once the file is regenerated" \
    "gh calls: $(cat "$D/work/.gh-calls")"
else
  ok "the hand-edit warning stops once the file is regenerated"
fi

# --- A non-publishable type generates nothing ---
D="$WORK/case-chore"
mkdir -p "$D"
make_repo "$D" "b4m-core/auth/src/index.ts"
run_step "$D/work" "chore(auth): bump a dev dependency" 905
if [ -f "$D/work/.changeset/pr-905.md" ]; then
  fail "a chore generates no changeset" "$(cat "$D/work/.changeset/pr-905.md")"
else
  ok "a chore generates no changeset"
fi

# --- verify-changeset.sh: fails whenever the bot would still commit ---
D="$WORK/verify-missing"
mkdir -p "$D"
make_repo "$D" "b4m-core/auth/src/index.ts"
expect_verify 1 "verify fails: feat PR with no changeset" "$D/work" "feat(auth): new grant type" 910

D="$WORK/verify-wrong-bump"
mkdir -p "$D"
make_repo "$D" "b4m-core/auth/src/index.ts"
run_step "$D/work" "fix(auth): correct token refresh" 911
expect_verify 1 "verify fails: patch changeset under a feat title" "$D/work" "feat(auth): new grant type" 911

D="$WORK/verify-stale"
mkdir -p "$D"
make_repo "$D" "b4m-core/auth/src/index.ts"
run_step "$D/work" "feat(auth): new grant type" 912
expect_verify 1 "verify fails: stale changeset after the title became chore" "$D/work" "chore(auth): tidy" 912

D="$WORK/verify-wrong-packages"
mkdir -p "$D"
make_repo "$D" "b4m-core/auth/src/index.ts"
run_step "$D/work" "fix(auth): correct token refresh" 913
(
  cd "$D/work"
  mkdir -p b4m-core/common/src
  printf '%s\n' "touched" >b4m-core/common/src/index.ts
  git add -A
  git commit --quiet -m "fix: also common"
  git push --quiet 2>/dev/null
)
expect_verify 1 "verify fails: changeset misses a newly touched package" "$D/work" "fix(auth): correct token refresh" 913

# --- verify-changeset.sh: passes every legitimate head ---
D="$WORK/verify-match"
mkdir -p "$D"
make_repo "$D" "b4m-core/auth/src/index.ts"
run_step "$D/work" "feat(auth): new grant type" 914
expect_verify 0 "verify passes: bot-generated changeset matches" "$D/work" "feat(auth): new grant type" 914

D="$WORK/verify-chore"
mkdir -p "$D"
make_repo "$D" "b4m-core/auth/src/index.ts"
expect_verify 0 "verify passes: chore title needs no changeset" "$D/work" "chore(auth): bump a dev dependency" 915

D="$WORK/verify-private"
mkdir -p "$D"
make_repo "$D" "apps/client/src/page.tsx"
expect_verify 0 "verify passes: diff touches only private packages" "$D/work" "feat(client): new page" 916

D="$WORK/verify-manual"
mkdir -p "$D"
make_repo "$D" "b4m-core/auth/src/index.ts"
(
  cd "$D/work"
  printf '%s\n' '---' '"@bike4mind/auth": minor' '---' '' 'Hand written.' >.changeset/hand-written.md
  git add -A
  git commit --quiet -m "chore: manual changeset"
  git push --quiet 2>/dev/null
)
expect_verify 0 "verify passes: manual changeset covers the bump" "$D/work" "fix(auth): correct token refresh" 917

D="$WORK/verify-opt-out"
mkdir -p "$D"
make_repo "$D" "b4m-core/auth/src/index.ts"
run_step "$D/work" "fix(auth): correct token refresh" 918
(
  cd "$D/work"
  git rm --quiet .changeset/pr-918.md
  git commit --quiet -m "chore: drop the auto-changeset"
  git push --quiet 2>/dev/null
)
expect_verify 0 "verify passes: human-deleted changeset (opt-out)" "$D/work" "fix(auth): correct token refresh" 918

# --- A title edit on a bot-authored head must regenerate, not skip ---
# The "Skip if last commit is from bot" step exists only to break the loop on the bot's
# own push; on an `edited` event it would leave the old bump in place.
if grep -A1 -- '- name: Skip if last commit is from bot' "$REPO_ROOT/.github/workflows/auto-changeset.yml" |
  grep -q "github.event.action == 'synchronize'"; then
  ok "bot-head skip applies only to synchronize"
else
  fail "bot-head skip applies only to synchronize"
fi

if grep -A1 '^concurrency:' "$REPO_ROOT/.github/workflows/auto-changeset.yml" |
  grep -q -- "-body-edit"; then
  ok "body-only edits do not share the generate run's concurrency group"
else
  fail "body-only edits do not share the generate run's concurrency group"
fi

echo
echo "passed: $PASSED  failed: $FAILED"
[ "$FAILED" -eq 0 ]

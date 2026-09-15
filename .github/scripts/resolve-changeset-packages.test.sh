#!/usr/bin/env bash
# Self-test for resolve-changeset-packages.sh.
# Usage: bash .github/scripts/resolve-changeset-packages.test.sh

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
RESOLVER="$SCRIPT_DIR/resolve-changeset-packages.sh"

PASSED=0
FAILED=0

# Builds a throwaway workspace shaped like this repo: two publishable core
# packages, one ignored core package, one private app.
make_workspace() {
  local root
  root=$(mktemp -d)

  mkdir -p "$root/.changeset" "$root/b4m-core/common" "$root/b4m-core/auth" \
    "$root/b4m-core/legacy" "$root/apps/client"

  cat >"$root/.changeset/config.json" <<'EOF'
{ "ignore": ["@bike4mind/legacy"] }
EOF
  cat >"$root/b4m-core/common/package.json" <<'EOF'
{ "name": "@bike4mind/common", "publishConfig": { "access": "public" } }
EOF
  cat >"$root/b4m-core/auth/package.json" <<'EOF'
{ "name": "@bike4mind/auth", "publishConfig": { "access": "public" } }
EOF
  cat >"$root/b4m-core/legacy/package.json" <<'EOF'
{ "name": "@bike4mind/legacy", "publishConfig": { "access": "public" } }
EOF
  cat >"$root/apps/client/package.json" <<'EOF'
{ "name": "@bike4mind/client", "private": true }
EOF

  printf '%s' "$root"
}

WORKSPACE=$(make_workspace)
trap 'rm -rf "$WORKSPACE"' EXIT

# expect <name> <scope> <changed-files> <expected-stdout> <expected-stderr-substring-or-empty>
expect() {
  local name="$1" scope="$2" files="$3" want_out="$4" want_err="${5:-}"
  local out err status=0 errfile
  errfile=$(mktemp)

  out=$(cd "$WORKSPACE" && printf '%s' "$files" | bash "$RESOLVER" "$scope" 2>"$errfile") || status=$?
  err=$(cat "$errfile")
  rm -f "$errfile"

  if [ "$status" -ne 0 ]; then
    echo "FAIL: $name -- resolver exited $status"
    echo "  stderr: $err"
    FAILED=$((FAILED + 1))
    return
  fi
  if [ "$out" != "$want_out" ]; then
    echo "FAIL: $name"
    echo "  expected stdout: [$want_out]"
    echo "  actual stdout:   [$out]"
    FAILED=$((FAILED + 1))
    return
  fi
  if [ -n "$want_err" ] && ! printf '%s' "$err" | grep -qF "$want_err"; then
    echo "FAIL: $name"
    echo "  expected stderr to contain: [$want_err]"
    echo "  actual stderr: [$err]"
    FAILED=$((FAILED + 1))
    return
  fi
  if [ -z "$want_err" ] && printf '%s' "$err" | grep -q 'unmatched-scope:'; then
    echo "FAIL: $name -- unexpected unmatched-scope report"
    echo "  actual stderr: [$err]"
    FAILED=$((FAILED + 1))
    return
  fi
  echo "PASS: $name"
  PASSED=$((PASSED + 1))
}

# The regression this script exists for: a scope naming a publishable package
# while every changed file lives in a private app must resolve to nothing.
expect 'scope-only, changes confined to a private app' \
  'auth' \
  'apps/client/src/auth/login.tsx
apps/client/src/auth/session.ts' \
  '' \
  'unmatched-scope: @bike4mind/auth'

expect 'scope-only, no changed files at all' \
  'common' \
  '' \
  '' \
  'unmatched-scope: @bike4mind/common'

expect 'scope matches a package the diff does touch' \
  'auth' \
  'b4m-core/auth/src/index.ts' \
  '@bike4mind/auth'

expect 'changed files outside the scope still resolve' \
  'auth' \
  'b4m-core/common/src/index.ts
b4m-core/auth/src/index.ts' \
  '@bike4mind/auth
@bike4mind/common'

expect 'no scope at all' \
  '' \
  'b4m-core/common/src/index.ts' \
  '@bike4mind/common'

expect 'multi-scope, only one backed by changed files' \
  'common,auth' \
  'b4m-core/common/src/index.ts' \
  '@bike4mind/common' \
  'unmatched-scope: @bike4mind/auth'

expect 'unknown scope is not reported' \
  'chat' \
  'b4m-core/common/src/index.ts' \
  '@bike4mind/common'

expect 'ignored package is never resolved' \
  'legacy' \
  'b4m-core/legacy/src/index.ts' \
  ''

expect 'private package is never resolved' \
  'client' \
  'apps/client/src/index.ts' \
  ''

expect 'a directory that merely shares a name prefix does not match' \
  '' \
  'b4m-core/common-extra/src/index.ts' \
  ''

echo
echo "passed: $PASSED  failed: $FAILED"
[ "$FAILED" -eq 0 ]

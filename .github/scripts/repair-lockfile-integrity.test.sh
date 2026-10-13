#!/usr/bin/env bash
# Fixture self-test for .github/scripts/repair-lockfile-integrity.sh.
#
# Usage: bash .github/scripts/repair-lockfile-integrity.test.sh

set -uo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
REPAIR="$REPO_ROOT/.github/scripts/repair-lockfile-integrity.sh"

PASSED=0
FAILED=0

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

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

XLSX_URL='https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz'
XLSX_HASHED="    resolution: {integrity: sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==, tarball: $XLSX_URL}"
AMP_URL='https://example.com/get?pkg=a&v=1.tgz'
AMP_HASHED="    resolution: {integrity: sha512-AMP==, tarball: $AMP_URL}"
GIT_LINE='    resolution: {gitHosted: true, tarball: https://codeload.github.com/o/r/tar.gz/4e449870cc177e04fa6c879e4d35947a601ce684}'

# Usage: lockfile <file> <resolution-line...>
lockfile() {
  local f="$1"
  shift
  {
    echo "lockfileVersion: '9.0'"
    echo
    echo 'packages:'
    for line in "$@"; do
      echo
      echo '  pkg:'
      echo "$line"
      echo '    version: 1.0.0'
    done
  } >"$f"
}

lockfile "$WORK/base.yaml" "$XLSX_HASHED" "$AMP_HASHED" "$GIT_LINE"

# --- (a) bare xlsx line restored byte-identical to base ---
lockfile "$WORK/a.yaml" "    resolution: {tarball: $XLSX_URL}" "$GIT_LINE"
lockfile "$WORK/a.want" "$XLSX_HASHED" "$GIT_LINE"
if bash "$REPAIR" "$WORK/a.yaml" "$WORK/base.yaml" && cmp -s "$WORK/a.yaml" "$WORK/a.want"; then
  ok "bare tarball entry gets the base integrity hash"
else
  fail "bare tarball entry gets the base integrity hash" "$(diff "$WORK/a.want" "$WORK/a.yaml")"
fi

# --- (b) gitHosted line untouched, even with no base match ---
lockfile "$WORK/b.yaml" '    resolution: {gitHosted: true, tarball: https://codeload.github.com/o/other/tar.gz/abc}'
cp "$WORK/b.yaml" "$WORK/b.want"
if bash "$REPAIR" "$WORK/b.yaml" "$WORK/base.yaml" && cmp -s "$WORK/b.yaml" "$WORK/b.want"; then
  ok "gitHosted entry is left alone"
else
  fail "gitHosted entry is left alone" "$(diff "$WORK/b.want" "$WORK/b.yaml")"
fi

# --- (c) URL missing from base: exit non-zero, URL printed, line left bare ---
NEW_URL='https://cdn.example.com/new-1.0.0.tgz'
lockfile "$WORK/c.yaml" "    resolution: {tarball: $NEW_URL}" "    resolution: {tarball: $XLSX_URL}"
lockfile "$WORK/c.want" "    resolution: {tarball: $NEW_URL}" "$XLSX_HASHED"
stderr=$(bash "$REPAIR" "$WORK/c.yaml" "$WORK/base.yaml" 2>&1 >/dev/null)
rc=$?
if [ "$rc" -ne 0 ] && [ "$stderr" = "$NEW_URL" ] && cmp -s "$WORK/c.yaml" "$WORK/c.want"; then
  ok "unknown URL fails, is reported, and stays bare"
else
  fail "unknown URL fails, is reported, and stays bare" "rc=$rc stderr=$stderr" "$(diff "$WORK/c.want" "$WORK/c.yaml")"
fi

# --- (d) clean lockfile is a byte-identical no-op ---
cp "$WORK/base.yaml" "$WORK/d.yaml"
if bash "$REPAIR" "$WORK/d.yaml" "$WORK/base.yaml" && cmp -s "$WORK/d.yaml" "$WORK/base.yaml"; then
  ok "clean lockfile is unchanged"
else
  fail "clean lockfile is unchanged" "$(diff "$WORK/base.yaml" "$WORK/d.yaml")"
fi

# --- (e) a URL containing "&" round-trips intact ---
lockfile "$WORK/e.yaml" "    resolution: {tarball: $AMP_URL}"
lockfile "$WORK/e.want" "$AMP_HASHED"
if bash "$REPAIR" "$WORK/e.yaml" "$WORK/base.yaml" && cmp -s "$WORK/e.yaml" "$WORK/e.want"; then
  ok "URL with & is restored intact"
else
  fail "URL with & is restored intact" "$(diff "$WORK/e.want" "$WORK/e.yaml")"
fi

echo
echo "passed: $PASSED  failed: $FAILED"
[ "$FAILED" -eq 0 ]

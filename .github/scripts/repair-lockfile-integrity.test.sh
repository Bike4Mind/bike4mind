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
GIT_URL='https://codeload.github.com/o/r/tar.gz/4e449870cc177e04fa6c879e4d35947a601ce684'
GIT_HASHED="    resolution: {integrity: sha512-GIT==, tarball: $GIT_URL}"
GIT_LINE="    resolution: {gitHosted: true, tarball: $GIT_URL}"

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

lockfile "$WORK/base.yaml" "$XLSX_HASHED" "$AMP_HASHED" "$GIT_LINE" "$GIT_HASHED"

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

# --- (f) two unknown URLs: both reported, both left bare ---
M1_URL='https://cdn.example.com/m1.tgz'
M2_URL='https://cdn.example.com/m2.tgz'
lockfile "$WORK/f.yaml" "    resolution: {tarball: $M1_URL}" "    resolution: {tarball: $M2_URL}"
cp "$WORK/f.yaml" "$WORK/f.want"
stderr=$(bash "$REPAIR" "$WORK/f.yaml" "$WORK/base.yaml" 2>&1 >/dev/null)
rc=$?
want_err=$(printf '%s\n%s' "$M1_URL" "$M2_URL")
if [ "$rc" -eq 1 ] && [ "$stderr" = "$want_err" ] && cmp -s "$WORK/f.yaml" "$WORK/f.want"; then
  ok "two unknown URLs are both reported and left bare"
else
  fail "two unknown URLs are both reported and left bare" "rc=$rc stderr=$stderr" "$(diff "$WORK/f.want" "$WORK/f.yaml")"
fi

# --- (g) the same bare URL twice: every occurrence is restored ---
lockfile "$WORK/g.yaml" "    resolution: {tarball: $XLSX_URL}" "    resolution: {tarball: $XLSX_URL}"
lockfile "$WORK/g.want" "$XLSX_HASHED" "$XLSX_HASHED"
if bash "$REPAIR" "$WORK/g.yaml" "$WORK/base.yaml" && cmp -s "$WORK/g.yaml" "$WORK/g.want"; then
  ok "a repeated bare URL is restored on every line"
else
  fail "a repeated bare URL is restored on every line" "$(diff "$WORK/g.want" "$WORK/g.yaml")"
fi

# --- (h) gitHosted line whose URL has a hashed base entry: still untouched ---
lockfile "$WORK/h.yaml" "$GIT_LINE"
cp "$WORK/h.yaml" "$WORK/h.want"
if bash "$REPAIR" "$WORK/h.yaml" "$WORK/base.yaml" && cmp -s "$WORK/h.yaml" "$WORK/h.want"; then
  ok "gitHosted entry stays untouched even with a matching hashed base entry"
else
  fail "gitHosted entry stays untouched even with a matching hashed base entry" "$(diff "$WORK/h.want" "$WORK/h.yaml")"
fi

# --- (i) empty PR lockfile is a bad input, not a clean one ---
: >"$WORK/i.yaml"
stderr=$(bash "$REPAIR" "$WORK/i.yaml" "$WORK/base.yaml" 2>&1 >/dev/null)
rc=$?
if [ "$rc" -eq 2 ]; then
  ok "empty PR lockfile is rejected"
else
  fail "empty PR lockfile is rejected" "rc=$rc stderr=$stderr"
fi

echo
echo "passed: $PASSED  failed: $FAILED"
[ "$FAILED" -eq 0 ]

#!/usr/bin/env bash
# CI gate: every file under pages/api/v1/** must use nextRouteForContract.
# "Public" = API-key-callable and OpenAPI-registered (CONVENTIONS.md).
# Exits 1 on any unacknowledged violation.
#
# ALLOWLIST (scripts/contract-gate-allowlist.txt)
#   Legitimate permanent exceptions (static v1 routes that are not API handlers).
#   Not migration debt: do not add real API handlers here.

set -euo pipefail

ALLOWLIST="scripts/contract-gate-allowlist.txt"
API_DIR="apps/client/pages/api/v1"

if [ ! -f "$ALLOWLIST" ]; then
  echo "ERROR: Allowlist not found at $ALLOWLIST"
  exit 1
fi

if [ ! -d "$API_DIR" ]; then
  echo "ERROR: API directory not found at $API_DIR"
  exit 1
fi

# v1 files that do not call nextRouteForContract(...).
# Matching the call (with the open paren) rather than the bare identifier means a
# "// TODO: port to nextRouteForContract" comment does not satisfy the check.
# Known limit: nextRouteForContract( inside a string literal also satisfies it.
# Under-enforcement rather than over-enforcement; acceptable for this gate.
# -Z/-0: null-delimit filenames so spaces or quotes in paths cannot confuse xargs.
# grep -rLZ exits 1 when every file matches (fully compliant = goal state) but 2 on a real
# error such as an unreadable directory; the latter must fail the gate rather than read as
# "no violators". Output goes through a file because command substitution drops the NULs.
scan_output=$(mktemp)
trap 'rm -f "$scan_output"' EXIT
scan_status=0
grep -rLZ "nextRouteForContract(" "$API_DIR" --include="*.ts" --include="*.tsx" --exclude-dir='__tests__' --exclude-dir='premium-*' \
  > "$scan_output" || scan_status=$?
if [ "$scan_status" -gt 1 ]; then
  echo "::error::grep failed (exit ${scan_status}) while scanning ${API_DIR}"
  echo "ERROR: Could not scan ${API_DIR}; refusing to report a clean result."
  exit 1
fi
violators=$(xargs -0 printf '%s\n' < "$scan_output" | sort)

# || true: grep -v '^$' exits 1 on a header-only (empty) allowlist.
allowed=$(grep -v '^#' "$ALLOWLIST" | grep -v '^$' | sed 's/[[:space:]]*#.*//' | sed 's/[[:space:]]*$//' | sort || true)

stale_entries=$(comm -23 <(echo "$allowed") <(echo "$violators") | grep -v '^$' || true)
new_violators=$(comm -23 <(echo "$violators") <(echo "$allowed") | grep -v '^$' || true)

if [ -n "$stale_entries" ]; then
  echo "INFO: These allowlist entries no longer need exemption -- remove them:"
  echo "$stale_entries" | sed 's/^/  /'
  echo ""
fi

if [ -z "$new_violators" ]; then
  echo "OK: No contract-gate violations."
  exit 0
fi

new_count=$(echo "$new_violators" | grep -c '.' || true)
echo "::error::${new_count} file(s) under pages/api/v1 are missing nextRouteForContract -- see job log"
echo ""
echo "ERROR: The following v1 files must use nextRouteForContract:"
echo ""
echo "$new_violators" | sed 's/^/  /'
echo ""
echo "Fix: route through nextRouteForContract (see b4m-core/common/src/api-contract/README.md)."
echo "Do NOT add to the allowlist -- this file is for permanent exceptions, not new handlers."

exit 1

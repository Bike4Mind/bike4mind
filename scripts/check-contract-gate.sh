#!/usr/bin/env bash
# CI gate: every API-key-authed endpoint (baseApi({ requiredScopes }) must route
# through the contract abstraction (nextRouteForContract / defineLambdaRoute).
#
# This enforces the invariant from b4m-core/common/src/api-contract/README.md:
# "Public == API-key-callable." A handler with requiredScopes that bypasses the
# contract layer can diverge from the OpenAPI spec and the typed client.
#
# MODES
#   warning (default): reports new violations but exits 0 so CI stays green
#                      while the initial migration is in progress.
#   error  (--error):  exits 1 on any new violation; flip CI to this mode once
#                      the allowlist is empty.
#
# ALLOWLIST (scripts/contract-gate-allowlist.txt)
#   Lists the pre-existing handlers that predate this gate. Each entry is a path
#   relative to the repo root. Entries are MIGRATION DEBT: remove one when the
#   handler is ported to nextRouteForContract, never add new ones.
#
# ADDING A NEW PUBLIC ENDPOINT
#   Use nextRouteForContract (see b4m-core/common/src/api-contract/README.md).
#   Adding it to the allowlist instead is not allowed for new endpoints.
#
# COVERAGE
#   This script covers pages/api/** (Next.js routes). Lambda handlers in
#   apps/workers/ are not scanned here because none currently use requiredScopes;
#   extend this script if that changes.

set -euo pipefail

ALLOWLIST="scripts/contract-gate-allowlist.txt"
API_DIR="apps/client/pages/api"
ERROR_MODE=0

for arg in "$@"; do
  [ "$arg" = "--error" ] && ERROR_MODE=1
done

if [ ! -f "$ALLOWLIST" ]; then
  echo "ERROR: Allowlist not found at $ALLOWLIST"
  exit 1
fi

# Files that use baseApi( with requiredScopes but NOT the contract adapter.
# nextRouteForContract and defineLambdaRoute both satisfy the requirement.
# || true: grep -rLE exits 1 when every file matches (fully migrated = goal state);
# xargs also exits 1 when its input is empty. Neither should abort the script.
violators=$(
  grep -rLE "nextRouteForContract|defineLambdaRoute" "$API_DIR" --include="*.ts" --exclude-dir='premium-*' \
  | xargs grep -lE "baseApi\(" 2>/dev/null \
  | xargs grep -lE "requiredScopes" 2>/dev/null \
  | grep -v '__tests__' \
  | sort \
  || true
)

allowed=$(grep -v '^#' "$ALLOWLIST" | grep -v '^$' | sed 's/[[:space:]]*#.*//' | sed 's/[[:space:]]*$//' | sort)

# Allowlist entries that no longer exist (already migrated or deleted).
stale_entries=$(comm -23 <(echo "$allowed") <(echo "$violators") | grep -v '^$' || true)

# Violators not yet on the allowlist (newly introduced, never acknowledged).
new_violators=$(comm -23 <(echo "$violators") <(echo "$allowed") | grep -v '^$' || true)

total_backlog=$(echo "$allowed" | grep -c '.' 2>/dev/null || true)
total_migrated=$((total_backlog - $(echo "$violators" | grep -c '.' 2>/dev/null || true)))
[ "$total_migrated" -lt 0 ] && total_migrated=0

if [ -n "$stale_entries" ]; then
  echo "INFO: The following allowlist entries are already migrated -- remove them:"
  echo "$stale_entries" | sed 's/^/  /'
  echo ""
fi

if [ -z "$new_violators" ]; then
  echo "OK: No new contract-gate violations. Migration progress: ${total_migrated}/${total_backlog} handlers ported."
  exit 0
fi

new_count=$(echo "$new_violators" | grep -c '.' || true)
# Surface in the GitHub Actions UI (annotation visible on the PR checks tab).
echo "::warning::${new_count} API-key-authed handler(s) lack a contract -- see job log for details"

echo "WARNING: The following API-key-authed handlers lack a contract (nextRouteForContract / defineLambdaRoute):"
echo ""
echo "$new_violators" | sed 's/^/  /'
echo ""
echo "Fix: route the handler through nextRouteForContract (see b4m-core/common/src/api-contract/README.md)."
echo "DO NOT add new endpoints to the allowlist -- the allowlist is migration debt only."
echo ""
echo "Migration progress: ${total_migrated}/${total_backlog} handlers ported."

if [ "$ERROR_MODE" -eq 1 ]; then
  exit 1
fi

exit 0

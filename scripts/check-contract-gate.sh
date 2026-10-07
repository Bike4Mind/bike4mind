#!/usr/bin/env bash
# CI gate: every public endpoint under pages/api/v1/** must route through
# nextRouteForContract. "Public" = API-key-callable and OpenAPI-registered
# (see b4m-core/common/src/api-contract/CONVENTIONS.md). Internal pages/api/*
# routes outside v1 are out of scope and stay plain handlers.
#
# MODES
#   warning (default): reports new violations but exits 0
#   error  (--error):  exits 1 on any new violation
#
# ALLOWLIST (scripts/contract-gate-allowlist.txt)
#   Migration debt: pre-existing v1 handlers not yet ported.
#   Remove entries as handlers are ported; never add new endpoints here.

set -euo pipefail

ALLOWLIST="scripts/contract-gate-allowlist.txt"
API_DIR="apps/client/pages/api/v1"
ERROR_MODE=0

for arg in "$@"; do
  [ "$arg" = "--error" ] && ERROR_MODE=1
done

if [ ! -f "$ALLOWLIST" ]; then
  echo "ERROR: Allowlist not found at $ALLOWLIST"
  exit 1
fi

if [ ! -d "$API_DIR" ]; then
  echo "ERROR: API directory not found at $API_DIR"
  exit 1
fi

# Files under pages/api/v1 that use baseApi with requiredScopes but lack the
# contract adapter (nextRouteForContract). The regex covers both plain calls
# (baseApi({) and generic calls (baseApi<Req, Res>({).
# || true: grep -rLE exits 1 when every file matches (fully migrated = goal state);
# xargs exits 1 on empty input. Neither should abort the script.
violators=$(
  grep -rLE "nextRouteForContract" "$API_DIR" --include="*.ts" --include="*.tsx" --exclude-dir='premium-*' \
  | xargs grep -lE "baseApi(<[^(]*)?\(" 2>/dev/null \
  | xargs grep -lE "requiredScopes" 2>/dev/null \
  | grep -v '__tests__' \
  | sort \
  || true
)

# || true: grep -v '^$' exits 1 on a header-only (empty) allowlist.
allowed=$(grep -v '^#' "$ALLOWLIST" | grep -v '^$' | sed 's/[[:space:]]*#.*//' | sed 's/[[:space:]]*$//' | sort || true)

# Allowlist entries that are no longer violating (migrated or deleted).
stale_entries=$(comm -23 <(echo "$allowed") <(echo "$violators") | grep -v '^$' || true)

# Violators not on the allowlist (newly introduced since the gate was added).
new_violators=$(comm -23 <(echo "$violators") <(echo "$allowed") | grep -v '^$' || true)

migrated=$(echo "$stale_entries" | grep -c '.' 2>/dev/null || true)
total_backlog=$(echo "$allowed" | grep -c '.' 2>/dev/null || true)

if [ -n "$stale_entries" ]; then
  echo "INFO: The following allowlist entries are already migrated -- remove them:"
  echo "$stale_entries" | sed 's/^/  /'
  echo ""
fi

if [ -z "$new_violators" ]; then
  msg="OK: No new contract-gate violations."
  [ "$total_backlog" -gt 0 ] && msg="$msg Migration progress: ${migrated}/${total_backlog} handlers ported."
  echo "$msg"
  exit 0
fi

new_count=$(echo "$new_violators" | grep -c '.' || true)
echo "::warning::${new_count} public handler(s) under pages/api/v1 lack a contract -- see job log for details"

echo "WARNING: The following handlers lack nextRouteForContract:"
echo ""
echo "$new_violators" | sed 's/^/  /'
echo ""
echo "Fix: route through nextRouteForContract (see b4m-core/common/src/api-contract/README.md)."
echo "DO NOT add new endpoints to the allowlist -- the allowlist is migration debt only."
[ "$total_backlog" -gt 0 ] && echo "" && echo "Migration progress: ${migrated}/${total_backlog} handlers ported."

if [ "$ERROR_MODE" -eq 1 ]; then
  exit 1
fi
exit 0

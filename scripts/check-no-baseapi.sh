#!/usr/bin/env bash
# Fails if any file under apps/client/pages/api/ lacks baseApi() and is not on the allowlist.
# Run in CI on every PR (ci.yml) and locally via husky pre-commit.
#
# To add a legitimate exception:
#   1. Add the path to scripts/no-baseapi-allowlist.txt
#   2. Add a comment explaining the alternative auth mechanism

set -euo pipefail

ALLOWLIST="scripts/no-baseapi-allowlist.txt"
API_DIR="apps/client/pages/api"

if [ ! -f "$ALLOWLIST" ]; then
  echo "❌ ERROR: Allowlist not found at $ALLOWLIST"
  exit 1
fi

# pages/api/premium-*/ is premium-overlay codegen output (gitignored, regenerated
# every build): bare `export { default } from '@bike4mind/premium-…'` re-exports.
# The real handlers behind them live in packages/premium/*/src/api and DO use
# baseApi — scanning the stubs only false-positives on trees where codegen ran.
#
# `nextRouteForContract` (the contract adapter, server/middlewares/defineNextRoute.ts)
# is auth-enforced: it builds on baseApi and applies the contract's scopes. A handler
# routed through it is authenticated exactly like a baseApi() handler, so it satisfies
# this check without a direct baseApi import.
violators=$(grep -rLE "baseApi|nextRouteForContract" "$API_DIR" --include="*.ts" --include="*.tsx" --exclude-dir='premium-*' | sort)

allowed=$(grep -v '^#' "$ALLOWLIST" | grep -v '^$' | sed 's/[[:space:]]*#.*//' | sed 's/[[:space:]]*$//' | sort)

new_violators=$(comm -23 <(echo "$violators") <(echo "$allowed") | grep -v '^$' || true)

if [ -n "$new_violators" ]; then
  echo "❌ ERROR: The following API files do not use baseApi() and are not on the allowlist:"
  echo ""
  echo "$new_violators" | sed 's/^/  /'
  echo ""
  echo "Fix options:"
  echo "  1. Use baseApi() directly, or route the handler through nextRouteForContract (contract adapter), OR"
  echo "  2. Add the path to scripts/no-baseapi-allowlist.txt with a comment explaining the alternative auth"
  exit 1
fi

echo "✅ All API files use baseApi() or are on the allowlist."

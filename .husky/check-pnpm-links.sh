#!/bin/bash

# Script to check for pnpm links in root package.json
# This script will identify any dependencies that use the "link:" protocol

PACKAGE_JSON="./package.json"
EXIT_CODE=0

echo "🔍 Checking for pnpm links in root package.json..."

if [ ! -f "$PACKAGE_JSON" ]; then
  echo "❌ Error: package.json not found in root directory"
  exit 1
fi

# Check for pnpm links in dependencies and devDependencies
PNPM_LINKS=$(jq -r '
    (.dependencies // {}) as $deps |
    (.devDependencies // {}) as $devDeps |
    ($deps + $devDeps) |
    to_entries[] |
    select(.value | startswith("link:")) |
    "\(.key): \(.value)"
' "$PACKAGE_JSON" 2>/dev/null)

if [ -n "$PNPM_LINKS" ]; then
  echo "⚠️  Found pnpm links in package.json:"
  echo "$PNPM_LINKS"
  echo ""
  echo "💡 Consider removing pnpm links before committing to avoid local path dependencies"
  EXIT_CODE=1
else
  echo "✅ No pnpm links found in package.json"
fi

exit $EXIT_CODE

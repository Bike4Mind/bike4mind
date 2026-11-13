#!/usr/bin/env bash
# Fails when the App Group id or keychain group drifts between the three entitlements files and the
# B4MKit constants. The ids are duplicated by necessity (plists cannot import Swift), so this is the guard.
set -euo pipefail

cd "$(dirname "$0")/.."

readonly APP_ENTITLEMENTS=(
  Bike4Mind/Resources/Bike4Mind.entitlements
  ShareExtension/ShareExtension.entitlements
  WidgetSupport/Widgets.entitlements
)
readonly KEYCHAIN_ENTITLEMENTS=(
  Bike4Mind/Resources/Bike4Mind.entitlements
  ShareExtension/ShareExtension.entitlements
)
readonly CONTAINER_SOURCE=Packages/B4MKit/Sources/B4MKit/Capture/SharedContainer.swift
readonly SNAPSHOT_SOURCE=Packages/B4MKit/Sources/B4MKit/Widgets/WidgetSnapshot.swift

failures=0
fail() {
  echo "entitlements parity: $*" >&2
  failures=$((failures + 1))
}

# Prints the <string> values under a plist key, one per line.
plist_values() {
  /usr/bin/python3 -I - "$1" "$2" <<'PY'
import plistlib, sys
with open(sys.argv[1], "rb") as handle:
    value = plistlib.load(handle).get(sys.argv[2], [])
print("\n".join(value if isinstance(value, list) else [value]))
PY
}

# Prints the quoted value of the first `<name> = "..."` assignment in a Swift file.
swift_constant() {
  sed -n "s/.*[[:space:]]$2[[:space:]]*=[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" | head -n 1
}

expected_group=$(swift_constant "$CONTAINER_SOURCE" appGroupIdentifier)
snapshot_group=$(swift_constant "$SNAPSHOT_SOURCE" identifier)
keychain_suffix=$(swift_constant "$CONTAINER_SOURCE" keychainGroupSuffix)

[ -n "$expected_group" ] || fail "appGroupIdentifier not found in $CONTAINER_SOURCE"
[ -n "$keychain_suffix" ] || fail "keychainGroupSuffix not found in $CONTAINER_SOURCE"
[ "$snapshot_group" = "$expected_group" ] ||
  fail "$SNAPSHOT_SOURCE has '$snapshot_group', $CONTAINER_SOURCE has '$expected_group'"

for file in "${APP_ENTITLEMENTS[@]}"; do
  actual=$(plist_values "$file" com.apple.security.application-groups)
  [ "$actual" = "$expected_group" ] || fail "$file application-groups is '$actual', expected '$expected_group'"
done

for file in "${KEYCHAIN_ENTITLEMENTS[@]}"; do
  actual=$(plist_values "$file" keychain-access-groups)
  [ "$actual" = "\$(AppIdentifierPrefix)$keychain_suffix" ] ||
    fail "$file keychain-access-groups is '$actual', expected '\$(AppIdentifierPrefix)$keychain_suffix'"
done

if [ "$failures" -gt 0 ]; then
  exit 1
fi
echo "entitlements parity: ok ($expected_group, $keychain_suffix)"

#!/usr/bin/env bash
# Fails when the App Group id, keychain group or background refresh id drifts between the plists and the
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
# Personal-team variants are exempt from the id rules above: a free Apple ID cannot sign App Groups,
# Keychain Sharing, Push or Associated Domains, so they must declare no capability at all.
readonly PERSONAL_ENTITLEMENTS=(
  Config/Entitlements/Bike4Mind.personal.entitlements
  Config/Entitlements/ShareExtension.personal.entitlements
  Config/Entitlements/Widgets.personal.entitlements
)
readonly SIGNING_CONFIG=Config/Signing.xcconfig
readonly LOCAL_CONFIG_EXAMPLE=Config/Local.xcconfig.example
readonly CONTAINER_SOURCE=Packages/B4MKit/Sources/B4MKit/Capture/SharedContainer.swift
readonly SNAPSHOT_SOURCE=Packages/B4MKit/Sources/B4MKit/Widgets/WidgetSnapshot.swift
readonly REFRESH_SOURCE=Packages/B4MKit/Sources/B4MKit/Briefs/BusyBlockBackgroundRefresh.swift
readonly APP_INFO_PLIST=AppSupport/Info.plist
readonly PROJECT_FILE=Bike4Mind.xcodeproj/project.pbxproj

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

# Prints the top-level keys of a plist, one per line.
plist_keys() {
  /usr/bin/python3 -I - "$1" <<'PY'
import plistlib, sys
with open(sys.argv[1], "rb") as handle:
    print("\n".join(plistlib.load(handle)))
PY
}

for file in "${PERSONAL_ENTITLEMENTS[@]}"; do
  keys=$(plist_keys "$file")
  [ -z "$keys" ] || fail "$file declares capabilities a personal team cannot sign: $(echo "$keys" | tr '\n' ' ')"
done

# Prints the value of `<name> = ...` in an xcconfig file.
xcconfig_value() {
  sed -n "s/^$2[[:space:]]*=[[:space:]]*//p" "$1" | head -n 1
}

# The xcconfig defaults must be the committed files checked above, and the example must point at
# personal variants that exist.
for pair in "B4M_APP_ENTITLEMENTS:${APP_ENTITLEMENTS[0]}" "B4M_SHARE_ENTITLEMENTS:${APP_ENTITLEMENTS[1]}" \
  "B4M_WIDGETS_ENTITLEMENTS:${APP_ENTITLEMENTS[2]}"; do
  variable=${pair%%:*}
  expected=${pair#*:}
  actual=$(xcconfig_value "$SIGNING_CONFIG" "$variable")
  [ "$actual" = "$expected" ] || fail "$SIGNING_CONFIG $variable is '$actual', expected '$expected'"
  example=$(xcconfig_value "$LOCAL_CONFIG_EXAMPLE" "$variable")
  [ -f "$example" ] || fail "$LOCAL_CONFIG_EXAMPLE $variable points at '$example', which does not exist"
done

# BGTaskScheduler refuses an identifier the Info.plist does not permit, so the app's id must match B4MKit's suffix.
refresh_suffix=$(swift_constant "$REFRESH_SOURCE" identifierSuffix)
[ -n "$refresh_suffix" ] || fail "identifierSuffix not found in $REFRESH_SOURCE"
permitted=$(plist_values "$APP_INFO_PLIST" BGTaskSchedulerPermittedIdentifiers)
[ "$permitted" = "\$(PRODUCT_BUNDLE_IDENTIFIER)$refresh_suffix" ] ||
  fail "$APP_INFO_PLIST BGTaskSchedulerPermittedIdentifiers is '$permitted', expected '\$(PRODUCT_BUNDLE_IDENTIFIER)$refresh_suffix'"
# Without the fetch background mode BGTaskScheduler.submit throws, and that is only logged.
modes=$(grep 'INFOPLIST_KEY_UIBackgroundModes' "$PROJECT_FILE" || true)
[ "$(printf '%s\n' "$modes" | grep -c '[" ]fetch[" ;]')" -ge 2 ] ||
  fail "$PROJECT_FILE INFOPLIST_KEY_UIBackgroundModes must include fetch in the Debug and Release app configs"

if [ "$failures" -gt 0 ]; then
  exit 1
fi
echo "entitlements parity: ok ($expected_group, $keychain_suffix)"

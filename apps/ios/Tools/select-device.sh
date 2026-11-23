#!/usr/bin/env bash
# Prints the CoreDevice UDID of the physical iPhone/iPad `make device` should target, or exits non-zero with an
# actionable message. Usage: select-device.sh [name-or-udid]. With no argument it needs exactly one connected device.
set -euo pipefail

readonly WANTED="${1:-}"

if ! listing="$(xcrun devicectl list devices --quiet --json-output /dev/stdout 2>/dev/null)"; then
  echo "error: 'xcrun devicectl list devices' failed. Install Xcode 15 or newer and select it with 'xcode-select -s'." >&2
  exit 1
fi

# A reachable phone reports tunnelState "disconnected" until something opens the tunnel on demand (xcodebuild and devicectl do),
# so only "unavailable" (remembered, not reachable) is skipped.
# Tab-separated "udid<TAB>name<TAB>model" for physical iOS devices that are paired and not unavailable.
available="$(python3 -I -c '
import json, sys
for d in json.load(sys.stdin)["result"]["devices"]:
    hardware = d.get("hardwareProperties", {})
    connection = d.get("connectionProperties", {})
    if hardware.get("reality") != "physical" or hardware.get("platform") != "iOS":
        continue
    if connection.get("pairingState") != "paired" or connection.get("tunnelState") == "unavailable":
        continue
    name = d.get("deviceProperties", {}).get("name", "?")
    print("\t".join([hardware.get("udid") or d["identifier"], name, hardware.get("marketingName", "?")]))
' <<<"$listing")"

if [ -n "$WANTED" ]; then
  matches="$(printf '%s\n' "$available" | awk -F'\t' -v w="$WANTED" 'NF && ($1 == w || $2 == w)')"
else
  matches="$available"
fi

count="$(printf '%s' "$matches" | grep -c . || true)"
case "$count" in
  1) printf '%s\n' "$matches" | cut -f1 ;;
  0)
    if [ -n "$WANTED" ]; then
      echo "error: no connected device matches DEVICE='$WANTED'." >&2
    else
      echo "error: no connected iPhone found." >&2
    fi
    echo "Plug the phone in, unlock it, tap Trust, and turn on Developer Mode (Settings > Privacy & Security). See DEVICE_TESTING.md." >&2
    exit 1
    ;;
  *)
    echo "error: $count devices found; pass DEVICE=<name|udid> to choose one:" >&2
    printf '%s\n' "$matches" | awk -F'\t' '{ printf "  %s  %s (%s)\n", $1, $2, $3 }' >&2
    exit 1
    ;;
esac

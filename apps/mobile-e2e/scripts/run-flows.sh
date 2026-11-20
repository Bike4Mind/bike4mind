#!/usr/bin/env bash
# Runs the shared Maestro flows against whatever device is booted (iOS simulator or Android emulator).
#
#   scripts/run-flows.sh <ios|android> [--quarantine]
#
# Blocking pass: smoke + fixture flows always run; live flows run only when the staging test-user env is
# present, otherwise they are skipped with a loud annotation. --quarantine runs flows/quarantine/ instead
# (non-blocking in CI). Reports land in $REPORT_DIR (default: ./report).
#
# MOBILE_E2E_SCOPE=smoke runs only the smoke + fixture flows (fast, no staging secrets needed); the default,
# full, also runs the live flows. CI uses smoke on ordinary mobile PRs and full on main, nightly and on demand.
set -euo pipefail

platform="${1:?usage: run-flows.sh <ios|android> [--quarantine]}"
mode="${2:-blocking}"
here="$(cd "$(dirname "$0")/.." && pwd)"
report_dir="${REPORT_DIR:-$here/report}"
mkdir -p "$report_dir"

case "$platform" in
  ios) exclude_tags="android-only" ;;
  android) exclude_tags="ios-only,fixture" ;; # Android has no canned-fixture mode
  *) echo "unknown platform: $platform" >&2; exit 2 ;;
esac

scope="${MOBILE_E2E_SCOPE:-full}"
case "$scope" in
  smoke | full) ;;
  *) echo "unknown MOBILE_E2E_SCOPE: $scope (smoke|full)" >&2; exit 2 ;;
esac

annotate() { # level, message
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::$1::$2"; else echo "$1: $2" >&2; fi
}

have_live_env=true
for name in B4M_E2E_SERVER_URL B4M_E2E_EMAIL B4M_E2E_CLEANUP_SECRET; do
  [ -n "${!name:-}" ] || have_live_env=false
done
include_args=()
if [ "$scope" = smoke ]; then
  include_args=(--include-tags smoke,fixture)
elif [ "$have_live_env" != true ]; then
  annotate warning "Mobile E2E ($platform): live flows SKIPPED - staging test-user secrets are not set (B4M_E2E_SERVER_URL, B4M_E2E_EMAIL, B4M_E2E_CLEANUP_SECRET). Only smoke/fixture flows ran."
  exclude_tags="$exclude_tags,live"
fi

cd "$here"
if [ "$mode" = "--quarantine" ]; then
  flows_target="flows/quarantine"
else
  flows_target="flows"
  exclude_tags="$exclude_tags,quarantine"
fi

if [ "$mode" = "--quarantine" ] && ! ls flows/quarantine/*.yaml >/dev/null 2>&1; then
  echo "No quarantined flows."
  exit 0
fi

# -e values are only passed when set, so a missing secret never becomes an empty-string env var.
env_args=()
for name in B4M_E2E_SERVER_URL B4M_E2E_EMAIL B4M_E2E_CLEANUP_SECRET; do
  [ -z "${!name:-}" ] || env_args+=(-e "$name=${!name}")
done

# MAESTRO_DEVICE (simulator UDID / adb serial) pins the device when several are booted.
maestro ${MAESTRO_DEVICE:+--device "$MAESTRO_DEVICE"} test --platform "$platform" \
  --exclude-tags "$exclude_tags" \
  --format junit --output "$report_dir/$platform-${mode#--}.xml" \
  --test-output-dir "$report_dir/$platform-${mode#--}-artifacts" \
  ${include_args[@]+"${include_args[@]}"} \
  ${env_args[@]+"${env_args[@]}"} "$flows_target"

#!/bin/sh
set -eu

# Self-test for .gitleaks.toml.
#
# Guards the failure mode that motivated this script: a config that loads without
# error while detecting nothing. The repo config previously ended in a
# `[useBuiltinRules]` table, which is not gitleaks config syntax - it parsed as an
# empty table, so every builtin rule was disabled and both CI and the pre-commit
# hook scanned with only the handful of domain rules below it. Nothing failed, and
# nothing caught an AWS key.
#
# Two directions are asserted, because fixing either one alone regresses the other:
#   1. A credential shape that MUST be caught is caught (builtin rules are loaded).
#   2. A known false positive stays quiet (the settings schema still commits).
#
# The canary is generated at runtime and written to a temp dir. Never commit a
# credential-shaped literal to this repo - GitHub secret scanning alerts on example
# values in tracked files, PR descriptions and comments, and cannot tell a
# fabricated one from a live one.

REPO_ROOT=$(git rev-parse --show-toplevel)
CONFIG="$REPO_ROOT/.gitleaks.toml"

GITLEAKS_PATH=$(command -v gitleaks 2>/dev/null || true)
if [ -z "$GITLEAKS_PATH" ]; then
  # Skipping is right for a contributor who has not installed gitleaks, but in CI a
  # skip is indistinguishable from a pass. Callers that install gitleaks themselves
  # set GITLEAKS_REQUIRED=1 so a broken install fails loudly instead.
  if [ "${GITLEAKS_REQUIRED:-0}" = "1" ]; then
    echo "FAIL: GITLEAKS_REQUIRED=1 but gitleaks is not on PATH."
    exit 1
  fi
  echo "gitleaks is not installed; skipping config self-test."
  echo "  Mac: brew install gitleaks"
  exit 0
fi

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

FAILED=0

# --- Assertion 1: builtin rules are loaded ------------------------------------
# An AWS-access-key shape is used because it comes from gitleaks' builtin ruleset,
# not from the domain rules in .gitleaks.toml, so it can only match when
# `[extend] useDefault = true` is in effect. Generated, never hardcoded. Do not
# substitute AWS's canonical documentation key - this repo allowlists it by design.
CANARY_SUFFIX=$(LC_ALL=C tr -dc 'A-Z0-9' < /dev/urandom | head -c 16)
printf "const canary = 'AKIA%s';\n" "$CANARY_SUFFIX" > "$TEMP_DIR/canary.ts"

if "$GITLEAKS_PATH" detect --no-git --redact --no-banner \
    --config "$CONFIG" -s "$TEMP_DIR" >/dev/null 2>&1; then
  echo "FAIL: builtin rules are not active - a planted AWS-key shape was not detected."
  echo "      Check that .gitleaks.toml still contains [extend] useDefault = true."
  FAILED=1
else
  echo "ok: builtin rules active (planted credential shape detected)"
fi

# --- Assertion 2: the known false positive stays quiet ------------------------
# The settings schema is a long list of camelCase feature-flag keys; several score
# high enough on entropy to trip the builtin generic-api-key heuristic. If this
# starts failing, staging that file blocks every commit and people reach for
# --no-verify, which skips the other pre-commit guards too.
SETTINGS="b4m-core/common/src/schemas/settings.ts"
if [ -f "$REPO_ROOT/$SETTINGS" ]; then
  if "$GITLEAKS_PATH" detect --no-git --redact --no-banner \
      --config "$CONFIG" -s "$REPO_ROOT/$SETTINGS" >/dev/null 2>&1; then
    echo "ok: $SETTINGS scans clean"
  else
    echo "FAIL: $SETTINGS reports a finding, so staging it will block commits."
    echo "      Re-check the generic-api-key handling in .gitleaks.toml."
    FAILED=1
  fi
fi

# --- Assertion 3: the global allowlist is honored -----------------------------
# The [[allowlists]] array form loads without error on 8.26 but is silently ignored
# by the 8.24.3 that CI pins, which would drop every path exclusion below it. That
# is invisible to assertions 1 and 2, so probe an excluded fixture directly.
#
# The probe is validated before it is trusted: the fixture is first scanned with no
# config at all, and must report something. If it does not, the fixture no longer
# contains a credential shape and this assertion would otherwise pass for the wrong
# reason - so say so instead of reporting a false ok.
PROBE="apps/client/app/utils/__tests__/error.test.ts"
if [ -f "$REPO_ROOT/$PROBE" ]; then
  if "$GITLEAKS_PATH" detect --no-git --redact --no-banner \
      -s "$REPO_ROOT/$PROBE" >/dev/null 2>&1; then
    echo "WARN: probe fixture $PROBE no longer trips the default ruleset."
    echo "      The path-allowlist assertion is now vacuous - pick another fixture."
  elif "$GITLEAKS_PATH" detect --no-git --redact --no-banner \
      --config "$CONFIG" -s "$REPO_ROOT/$PROBE" >/dev/null 2>&1; then
    echo "ok: path allowlist honored (test fixture excluded)"
  else
    echo "FAIL: $PROBE reports a finding, so the global allowlist is being ignored."
    echo "      Check that .gitleaks.toml still uses the singular [allowlist] table:"
    echo "      the [[allowlists]] array form is silently ignored by gitleaks 8.24.3."
    FAILED=1
  fi
fi

if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "gitleaks config self-test FAILED. The config may load cleanly and still"
  echo "detect nothing, so treat this as a secret-scanning outage, not a lint nit."
  exit 1
fi

echo "gitleaks config self-test passed."

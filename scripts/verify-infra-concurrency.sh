#!/usr/bin/env bash
#
# verify-infra-concurrency.sh — Phase C verification for #9155
#
# Confirms that the reserved-concurrency settings relocated in #9155 actually
# land on the deployed Lambdas. `tsc` proves the SST config is well-formed; only
# a live check proves the values reach AWS — the web.ts setting was a silent
# no-op before this fix, so "it deploys" is not the same as "it applies".
#
# Run AFTER deploying the branch to a stage (default: dev = staging per CLAUDE.md).
#
#   STAGE=dev ./scripts/verify-infra-concurrency.sh            # staging
#   STAGE=production ./scripts/verify-infra-concurrency.sh
#
# By default it asserts each target simply HAS reserved concurrency set (> 0) —
# that is the #9155 regression (no-op → applied) and avoids duplicating the magic
# numbers that live in infra/web.ts and infra/queues.ts. To pin exact values:
#
#   EXPECT_FRONTEND=150 EXPECT_OVERWATCH=10 STAGE=dev ./scripts/verify-infra-concurrency.sh
#
# Requires: aws CLI v2 with credentials for the target account (no jq needed).
# Exits 0 = all good, 1 = a reservation is missing/wrong/ambiguous, 2 = setup error.

set -euo pipefail

STAGE="${STAGE:-dev}"
REGION="${AWS_REGION:-us-east-1}"
EXPECT_FRONTEND="${EXPECT_FRONTEND:-}" # empty → only require reserved > 0
EXPECT_OVERWATCH="${EXPECT_OVERWATCH:-}"

# Reserved concurrency is only configured on the full-scale stages
# (infra/constants.ts: PRODUCTION_STAGES = ['production','dev']). Other stages
# (PR previews, personal sst-dev) intentionally leave it unreserved.
if [[ "$STAGE" != "production" && "$STAGE" != "dev" ]]; then
  echo "ℹ️  Stage '$STAGE' does not set reserved concurrency — nothing to verify."
  exit 0
fi

command -v aws >/dev/null || {
  echo "❌ aws CLI not found"
  exit 2
}

TMP_RUN="$(mktemp -d)"
trap 'rm -rf "$TMP_RUN"' EXIT
ERR="$TMP_RUN/err"

if ! aws sts get-caller-identity >/dev/null 2>"$ERR"; then
  echo "❌ No usable AWS credentials for stage '$STAGE'. Run 'aws login' / set a profile."
  cat "$ERR" >&2
  exit 2
fi

fail=0

# Print (one per line) the names of this stage's functions whose name contains
# <token>, minus an optional exclusion regex. No matches → no output, rc 0, so
# the caller handles "not found" gracefully instead of the script aborting.
# AWS CLI v2 auto-paginates, so this covers accounts with any number of functions.
list_matches() {
  local token="$1" exclude="${2:-}" names n
  if ! names="$(aws lambda list-functions --region "$REGION" \
    --query "Functions[?starts_with(FunctionName, \`${STAGE}-\`) && contains(FunctionName, \`${token}\`)].FunctionName" \
    --output text 2>"$ERR")"; then
    echo "❌ aws lambda list-functions failed:" >&2
    cat "$ERR" >&2
    return 2
  fi
  # --output text is tab/space separated; function names contain no spaces, so
  # plain word-splitting is safe and avoids any head/pipefail SIGPIPE footgun.
  for n in $names; do
    [[ -n "$exclude" && "$n" =~ $exclude ]] && continue
    printf '%s\n' "$n"
  done
}

# Echo a function's ReservedConcurrentExecutions, or "unset". Surfaces (rather
# than swallows) a real API error so an auth/throttle failure is never
# misreported as a concurrency mismatch.
reserved_for() {
  local fn="$1" val
  if ! val="$(aws lambda get-function-concurrency --region "$REGION" \
    --function-name "$fn" --query 'ReservedConcurrentExecutions' --output text 2>"$ERR")"; then
    echo "❌ get-function-concurrency failed for $fn:" >&2
    cat "$ERR" >&2
    return 2
  fi
  # AWS CLI prints the literal "None" (not empty) when no reservation is set.
  [[ -z "$val" || "$val" == "None" ]] && val="unset"
  printf '%s' "$val"
}

check() {
  local label="$1" token="$2" expected="$3" exclude="${4:-}"
  local names_file="$TMP_RUN/names"
  if ! list_matches "$token" "$exclude" >"$names_file"; then
    fail=1
    return # list_matches already surfaced the AWS error
  fi

  # Plain read loop (not mapfile/readarray) so this runs on macOS's bash 3.2.
  local -a fns=()
  local line
  while IFS= read -r line; do
    [[ -n "$line" ]] && fns+=("$line")
  done <"$names_file"

  if [[ "${#fns[@]}" -eq 0 ]]; then
    echo "❌ $label: no '${STAGE}-*${token}*' function found (is the stage deployed?)"
    fail=1
    return
  fi
  if [[ "${#fns[@]}" -gt 1 ]]; then
    echo "❌ $label: ambiguous — multiple '$token' functions match:"
    printf '     - %s\n' "${fns[@]}"
    echo "     refine the token/exclusion so exactly one matches."
    fail=1
    return
  fi

  local fn="${fns[0]}" reserved
  if ! reserved="$(reserved_for "$fn")"; then
    fail=1
    return
  fi

  if [[ "$reserved" == "unset" ]]; then
    echo "❌ $label: $fn → reserved=<unset> (expected ${expected:-a positive value})"
    fail=1
  elif [[ -n "$expected" && "$reserved" != "$expected" ]]; then
    echo "❌ $label: $fn → reserved=$reserved (expected $expected)"
    fail=1
  elif [[ -z "$expected" && ! "$reserved" =~ ^[1-9][0-9]*$ ]]; then
    echo "❌ $label: $fn → reserved=$reserved (expected a positive value)"
    fail=1
  else
    echo "✅ $label: $fn → reserved=$reserved"
  fi
}

echo "Verifying reserved concurrency on stage '$STAGE' (region $REGION)…"
echo

# infra/web.ts — Nextjs 'frontend' SERVER function. SST also generates auxiliary
# 'frontend' Lambdas (image optimizer, warmer, revalidation) that carry no
# reservation; exclude them so we assert against the server function only.
check "frontend" "frontend" "$EXPECT_FRONTEND" '([Ii]mageOptimizer|[Ww]armer|[Rr]evalidation|[Oo]ptimizer)'
# infra/queues.ts — overwatchAnalytics dispatch subscriber.
check "overwatch" "overwatch" "$EXPECT_OVERWATCH"

echo
if [[ "$fail" -ne 0 ]]; then
  echo "❌ Verification FAILED."
  exit 1
fi
echo "✅ All reserved-concurrency checks passed for stage '$STAGE'."

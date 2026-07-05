#!/usr/bin/env bash
#
# Force-clear a stuck SST state lock for the current personal dev stage.
#
# WHEN TO USE: `npx sst unlock` reports "✓ Unlocked" but `sst dev` / `sst deploy`
# still errors "A concurrent update was detected on the app. Run `sst unlock`...".
# That means a crashed/interrupted deploy (e.g. a hung TUI you couldn't Ctrl-C, or
# two clones running `sst dev` against the same stage) left a stale lock OBJECT in
# the S3 state backend that `sst unlock` isn't actually removing. This deletes it
# directly — exactly what unlock is supposed to do, just guaranteed.
#
# Run from the repo root:  pnpm sst:unlock:force   (or: bash scripts/sst-force-unlock.sh)
#
# Stage is read from .sst/stage; app from SEED_APP_NAME; the state BUCKET is resolved from
# the SSM /sst/bootstrap pointer — the same source SST itself uses — NOT by globbing
# sst-state-* buckets, because `aws s3 ls` can surface empty DECOY sst-state-* buckets while
# omitting the real one (that cost an hour on 2026-06-28).
# Overrides: SEED_APP_NAME, SST_STAGE, SST_STATE_BUCKET, SST_REGION (default from sst.config.ts).
#
# Context: incidents 2026-06-27 / 2026-06-28 — bike4mind/erikbethke stage lock wedged; both
# `npx sst unlock` (reported success but left the object) and the old glob-based bucket
# detection failed. SSM bootstrap resolution is the fix.
set -euo pipefail

APP="${SEED_APP_NAME:-bike4mind}"
STAGE="${SST_STAGE:-$(cat .sst/stage 2>/dev/null || whoami)}"

# Region: explicit override, else AWS_* env, else parse sst.config.ts, else us-east-2.
REGION="${SST_REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"
if [ -z "$REGION" ]; then
  REGION="$(grep -oE "region:[[:space:]]*['\"][a-z]+-[a-z]+-[0-9]+['\"]" sst.config.ts 2>/dev/null | grep -oE "[a-z]+-[a-z]+-[0-9]+" | head -1)"
fi
REGION="${REGION:-us-east-2}"

# Guard: never nuke a lock that a LIVE sst/pulumi process legitimately holds.
if pgrep -fl "sst dev|sst deploy|pulumi" >/dev/null 2>&1; then
  echo "⚠️  A live sst/pulumi process is running — its lock is probably legitimate."
  echo "    Stop it first (Ctrl-C, or kill it), confirm no stray dev procs, then re-run. Aborting."
  exit 1
fi

# Resolve the SST state bucket. Order: explicit override -> SSM /sst/bootstrap (.state,
# authoritative) -> glob fallback. The SSM pointer is what SST itself reads, so it names
# the REAL bucket even when `aws s3 ls` only shows empty decoys (or omits the real one).
if [ -n "${SST_STATE_BUCKET:-}" ]; then
  BUCKET="$SST_STATE_BUCKET"
  echo "🔎 bucket from SST_STATE_BUCKET override: $BUCKET"
else
  # Capture stdout+stderr together: on success BOOTSTRAP holds the value; on failure it
  # holds the AWS error, so we distinguish a genuine ParameterNotFound (quiet fallback to
  # glob) from an auth/network problem (surface it — never mislead with "not found").
  if BOOTSTRAP="$(aws ssm get-parameter --name /sst/bootstrap --region "$REGION" --query 'Parameter.Value' --output text 2>&1)"; then
    BUCKET="$(printf '%s' "$BOOTSTRAP" | grep -oE '"state":"[^"]*"' | sed 's/.*:"//;s/"$//')"
  else
    if ! printf '%s' "$BOOTSTRAP" | grep -qiE 'ParameterNotFound'; then
      echo "❌ Could not read SSM /sst/bootstrap (not a simple not-found) — surfacing AWS error:"
      printf '   %s\n' "$BOOTSTRAP"
      exit 1
    fi
    BUCKET=""   # genuine ParameterNotFound → fall through to glob below
  fi
  if [ -n "$BUCKET" ]; then
    echo "🔎 bucket from SSM /sst/bootstrap (${REGION}): $BUCKET"
  else
    # Fallback: no SSM bootstrap value — glob sst-state-* (legacy). Still refuse to
    # guess among multiples, since this op DELETES. (Prefer SST_STATE_BUCKET in that case.)
    echo "ℹ️  No SSM /sst/bootstrap state in ${REGION}; falling back to bucket glob."
    if ! BUCKET_LIST="$(aws s3 ls 2>&1)"; then
      echo "❌ Could not list S3 buckets — is your AWS SSO/profile active for the deploy account? AWS said:"
      printf '   %s\n' "$BUCKET_LIST"
      exit 1
    fi
    BUCKETS="$(printf '%s\n' "$BUCKET_LIST" | awk '/ sst-state-/{print $3}')"
    COUNT="$(printf '%s' "$BUCKETS" | grep -c . || true)"
    if [ "$COUNT" -eq 0 ]; then
      echo "❌ No SSM bootstrap and no sst-state-* bucket found. Set SST_STATE_BUCKET=... explicitly."
      exit 1
    elif [ "$COUNT" -gt 1 ]; then
      echo "❌ No SSM bootstrap, and multiple sst-state-* buckets — refusing to guess for a destructive op:"
      printf '   %s\n' $BUCKETS
      echo "   Re-run with SST_STATE_BUCKET=<bucket> (the SSM pointer's .state value is the real one)."
      exit 1
    fi
    BUCKET="$(printf '%s\n' "$BUCKETS" | head -1)"
  fi
fi

KEY="lock/${APP}/${STAGE}.json"
echo "🔎 app=${APP}  stage=${STAGE}  bucket=${BUCKET}"
echo "🔎 lock object: s3://${BUCKET}/${KEY}"

# Existence check that distinguishes "no lock" from a real failure. A genuine
# absence returns 404 / Not Found; any OTHER error (AccessDenied, expired SSO,
# wrong bucket, network) must SURFACE and exit non-zero — never be reported as
# "already unlocked", which would silently hide the real problem.
if HEAD_ERR="$(aws s3api head-object --region "$REGION" --bucket "$BUCKET" --key "$KEY" 2>&1 >/dev/null)"; then
  echo "--- current lock contents ---"
  aws s3 cp --region "$REGION" "s3://${BUCKET}/${KEY}" - 2>/dev/null | sed 's/^/   /' || true
  echo "-----------------------------"
  echo "🧨 deleting stale lock..."
  aws s3 rm --region "$REGION" "s3://${BUCKET}/${KEY}"
  echo "✅ lock cleared — now run: npx sst dev"
elif printf '%s' "$HEAD_ERR" | grep -qiE "Not Found|404|NoSuchKey"; then
  echo "✅ no lock object present — already unlocked. run: npx sst dev"
else
  echo "❌ Could not check the lock object (not a simple 'not found') — surfacing the AWS error:"
  printf '   %s\n' "$HEAD_ERR"
  exit 1
fi

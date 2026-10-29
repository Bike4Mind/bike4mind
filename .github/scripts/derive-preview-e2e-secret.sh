#!/usr/bin/env bash
# Source from a workflow step: `. .github/scripts/derive-preview-e2e-secret.sh "$STAGE"`.
# Exports E2E_CLEANUP_SECRET = HMAC-SHA256(E2E_PREVIEW_SEED, stage) as lowercase hex, masked in logs.
# Leaves it empty when the seed is unset so the caller's "not configured" skip still fires.

E2E_CLEANUP_SECRET=""
if [ -n "${E2E_PREVIEW_SEED:-}" ]; then
  E2E_CLEANUP_SECRET="$(printf '%s' "$1" | openssl dgst -sha256 -hmac "$E2E_PREVIEW_SEED" -r | cut -d' ' -f1)"
  echo "::add-mask::$E2E_CLEANUP_SECRET"
fi
export E2E_CLEANUP_SECRET

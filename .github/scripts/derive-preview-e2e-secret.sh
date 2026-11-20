#!/usr/bin/env bash
# Source from a workflow step: `. .github/scripts/derive-preview-e2e-secret.sh "$STAGE"`.
# Exports E2E_CLEANUP_SECRET = HMAC-SHA256(E2E_PREVIEW_SEED, stage) as lowercase hex, masked in logs.
# Leaves it empty when the seed is unset so the caller's "not configured" skip still fires.
# Returns 1 if derivation fails, so a scrub step cannot pass while missing the value that was sent.
# Unsets the seed so the test process never inherits it.

E2E_CLEANUP_SECRET=""
if [ -n "${E2E_PREVIEW_SEED:-}" ]; then
  # Python reads the seed from env; openssl -hmac would expose it in argv.
  E2E_CLEANUP_SECRET="$(python3 -c 'import hashlib, hmac, os, sys; print(hmac.new(os.environ["E2E_PREVIEW_SEED"].encode(), sys.argv[1].encode(), hashlib.sha256).hexdigest())' "$1")" || E2E_CLEANUP_SECRET=""
  if ! [[ "$E2E_CLEANUP_SECRET" =~ ^[0-9a-f]{64}$ ]]; then
    unset E2E_PREVIEW_SEED E2E_CLEANUP_SECRET
    echo "::error::Could not derive the preview E2E cleanup secret for stage '$1'."
    return 1
  fi
  echo "::add-mask::$E2E_CLEANUP_SECRET"
fi
unset E2E_PREVIEW_SEED
export E2E_CLEANUP_SECRET

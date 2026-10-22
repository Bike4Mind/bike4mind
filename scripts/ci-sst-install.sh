#!/usr/bin/env bash
set -euo pipefail

readonly MAX_ATTEMPTS=3
readonly RETRY_DELAY_SECONDS=5

# Provider installation can fail transiently on fresh runners, before any code checks run.
for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
  if pnpm sst install --print-logs; then
    exit 0
  else
    install_status=$?
  fi

  if ((attempt == MAX_ATTEMPTS)); then
    printf '::error::SST installation failed after %s attempts (exit %s).\n' "$attempt" "$install_status" >&2
    exit "$install_status"
  fi

  delay_seconds=$((attempt * RETRY_DELAY_SECONDS))
  printf '::warning::SST installation failed (exit %s); retrying in %s seconds (%s/%s).\n' \
    "$install_status" "$delay_seconds" "$attempt" "$MAX_ATTEMPTS" >&2
  sleep "$delay_seconds"
done

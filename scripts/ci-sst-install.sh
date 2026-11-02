#!/usr/bin/env bash
set -euo pipefail

readonly MAX_ATTEMPTS=3
readonly RETRY_DELAY_SECONDS=5
# A provider download from GitHub releases can stall without ever failing, which would hold the job
# until its own timeout; bounding each attempt turns a stall into a retry. Overridable for tests.
readonly ATTEMPT_TIMEOUT_SECONDS="${SST_INSTALL_ATTEMPT_TIMEOUT_SECONDS:-300}"

bounded=()
if command -v timeout >/dev/null 2>&1; then
  bounded=(timeout --kill-after=30 "$ATTEMPT_TIMEOUT_SECONDS")
fi

# Provider installation can fail transiently on fresh runners, before any code checks run.
for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
  if ${bounded[@]+"${bounded[@]}"} pnpm sst install --print-logs; then
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

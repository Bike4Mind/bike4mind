#!/usr/bin/env bash
# Usage: audit-report.sh <dir> <out>
# Writes `pnpm audit --json` for <dir> to <out>, retrying up to 3 times. An
# attempt counts only when the output is a recognized audit report, so a
# registry outage is reported as infrastructure instead of reaching
# scripts/audit-gate.mjs as "advisories found" or "clean".
set -euo pipefail

dir="$1"
out="$2"
delays=(15 45)

for attempt in 1 2 3; do
  # pnpm audit exits 1 when it finds vulnerabilities, so its exit code means nothing here.
  pnpm --dir "$dir" audit --json > "$out" 2>/dev/null || true
  if node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const ok = d && typeof d === "object" && !d.error &&
      ((d.advisories && typeof d.advisories === "object") ||
       (d.vulnerabilities && typeof d.vulnerabilities === "object"));
    process.exit(ok ? 0 : 1);
  ' "$out" 2>/dev/null; then
    exit 0
  fi
  if [ "$attempt" -lt 3 ]; then
    echo "pnpm audit attempt $attempt did not return a usable report; retrying in ${delays[$((attempt - 1))]}s"
    sleep "${delays[$((attempt - 1))]}"
  fi
done

echo "::error::pnpm audit did not return a usable report after 3 attempts (registry/infrastructure problem, not an advisory) -- re-run the job"
head -n 20 "$out" || true
exit 1

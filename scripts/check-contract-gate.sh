#!/usr/bin/env bash
# CI gate over apps/client/pages/api and infra/, four scans:
#   1. every file under pages/api/v1/** must use nextRouteForContract.
#      "Public" = API-key-callable and OpenAPI-registered (CONVENTIONS.md).
#   2. every file OUTSIDE pages/api/v1 must declare `auth: 'jwtOnly'` (the api-key chain is
#      never installed in that mode, see server/middlewares/baseApi.ts), or be on the frozen
#      baseline. A new handler that accepts API keys must go through a v1 contract instead.
#   3. every file that accepts API keys (no `auth: 'jwtOnly'`) and calls an LLM must name a
#      credit-billing seam (server/billing/meterPlatformCompletion.ts), or be on the baseline.
#   4. every `sst.aws.Function` in infra/ that exposes a Function URL (`url:`) must have a
#      handler built on defineLambdaRoute, or be on the function-url baseline. A Function URL
#      skips the Next.js middleware chain, so the contract has to be wired at the handler;
#      the pages/api scans cannot see a Lambda declared in infra/.
# Exits 1 on any unacknowledged violation.
#
# ALLOWLISTS
#   scripts/contract-gate-allowlist.txt (scan 1)
#     Legitimate permanent exceptions (static v1 routes that are not API handlers).
#     Not migration debt: do not add real API handlers here.
#   scripts/contract-gate-api-key-allowlist.txt (scan 2)
#     Frozen baseline of handlers that predate the ratchet. It only shrinks.
#   scripts/unmetered-llm-route-allowlist.txt (scan 3)
#     Key-accepting LLM handlers not yet credit-metered. It only shrinks.
#   scripts/contract-gate-function-url-allowlist.txt (scan 4)
#     Frozen baseline of Function URL handlers that predate the ratchet. Entries are only ever
#     removed, and every entry must carry a trailing `# reason` (the gate rejects one without).

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

ALLOWLIST="scripts/contract-gate-allowlist.txt"
ALLOWLIST_API_KEY="scripts/contract-gate-api-key-allowlist.txt"
ALLOWLIST_UNMETERED="scripts/unmetered-llm-route-allowlist.txt"
ALLOWLIST_FUNCTION_URL="scripts/contract-gate-function-url-allowlist.txt"
API_ROOT="apps/client/pages/api"
API_DIR="$API_ROOT/v1"
INFRA_DIR="infra"

for f in "$ALLOWLIST" "$ALLOWLIST_API_KEY" "$ALLOWLIST_UNMETERED" "$ALLOWLIST_FUNCTION_URL"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: Allowlist not found at $f"
    exit 1
  fi
done

if [ ! -d "$API_DIR" ]; then
  echo "ERROR: API directory not found at $API_DIR"
  exit 1
fi

if [ ! -d "$INFRA_DIR" ]; then
  echo "ERROR: Infra directory not found at $INFRA_DIR"
  exit 1
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

# Routable handler files under the given roots, NUL-delimited into $tmp.
# Extensions must stay in sync with pageExtensions in apps/client/next.config.*.
# premium-* codegen stubs are pruned only as directories at $API_ROOT/premium-* (anchored):
# grep's --exclude-dir would match that name at any depth and skip a real v1 directory, and
# a top-level premium-foo.ts file is a committed, routable handler that must stay scanned.
# A find failure (e.g. an unreadable directory) must fail the gate, not read as "no files".
list_files() {
  local status=0
  find "$@" \( -name __tests__ -o \( -type d -path "$API_ROOT/premium-*" \) \) -prune -o -type f \
    \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \) -print0 > "$tmp" || status=$?
  if [ "$status" -ne 0 ]; then
    echo "::error::find failed (exit ${status}) while scanning ${API_ROOT}"
    echo "ERROR: Could not scan ${API_ROOT}; refusing to report a clean result."
    exit 1
  fi
}

# Print (sorted) the files in $tmp that do not match the ERE $1.
# grep -q exits 1 on "no match" (a violator) but 2 on a real error, which must fail the gate.
files_missing() {
  local f rc
  while IFS= read -r -d '' f; do
    rc=0
    grep -qE -- "$1" "$f" || rc=$?
    if [ "$rc" -eq 1 ]; then
      printf '%s\n' "$f"
    elif [ "$rc" -gt 1 ]; then
      echo "::error::grep failed (exit ${rc}) on ${f}" >&2
      exit 1
    fi
  done < "$tmp" | sort
}

# grep -qE $1 on file $2: 0 on a match, 1 on none; a real grep error (exit 2) fails the gate.
has_match() {
  local rc=0
  grep -qE -- "$1" "$2" || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "::error::grep failed (exit ${rc}) on $2" >&2
    exit 1
  fi
  return "$rc"
}

# Print (sorted) the files in $tmp that match the ERE $1 but neither $2 nor $3.
files_matching_without() {
  local f
  while IFS= read -r -d '' f; do
    has_match "$1" "$f" || continue
    has_match "$2" "$f" && continue
    has_match "$3" "$f" && continue
    printf '%s\n' "$f"
  done < "$tmp" | sort
}

# Entries of an allowlist file, comments stripped, sorted.
# || true: grep -v '^$' exits 1 on a header-only (empty) allowlist.
read_allowlist() {
  { grep -v '^#' "$1" | grep -v '^$' | sed 's/[[:space:]]*#.*//' | sed 's/[[:space:]]*$//' | sort -u; } || true
}

# Diff violators ($2) against an allowlist ($1); print INFO for stale entries and, if any
# violator is new, the error block ($3 = summary, $4 = fix hint). Returns 1 on new violators.
report() {
  local allowed violators stale fresh count missing p rc=0
  allowed=$(read_allowlist "$1")
  violators=$2
  stale=$(comm -23 <(echo "$allowed") <(echo "$violators") | grep -v '^$' || true)
  fresh=$(comm -23 <(echo "$violators") <(echo "$allowed") | grep -v '^$' || true)

  missing=""
  if [ -n "$stale" ]; then
    while IFS= read -r p; do
      [ -e "$p" ] || missing+="${p}"$'\n'
    done <<< "$stale"
    missing=$(printf '%s' "$missing" | grep -v '^$' || true)
    stale=$(comm -23 <(echo "$stale") <(echo "$missing") | grep -v '^$' || true)
  fi

  if [ -n "$missing" ]; then
    echo "::error::allowlist entries in $1 name files that no longer exist -- see job log"
    echo ""
    echo "ERROR: these allowlist entries in $1 name files that no longer exist -- remove them (a new file at that path must not inherit the exemption):"
    echo "$missing" | sed 's/^/  /'
    echo ""
    rc=1
  fi

  if [ -n "$stale" ]; then
    echo "INFO: These allowlist entries in $1 no longer need exemption -- remove them:"
    echo "$stale" | sed 's/^/  /'
    echo ""
  fi
  [ -z "$fresh" ] && return "$rc"

  count=$(echo "$fresh" | grep -c '.' || true)
  echo "::error::${count} file(s) ${3} -- see job log"
  echo ""
  echo "ERROR: ${count} file(s) ${3}:"
  echo ""
  echo "$fresh" | sed 's/^/  /'
  echo ""
  echo "$4"
  echo ""
  return 1
}

failed=0

# Scan 1: v1 files that do not call nextRouteForContract(...).
# Matching the call (with the open paren) rather than the bare identifier means a
# "// TODO: port to nextRouteForContract" comment does not satisfy the check.
# Known limit: nextRouteForContract( inside a string literal also satisfies it.
# Under-enforcement rather than over-enforcement; acceptable for this gate.
list_files "$API_DIR"
v1_violators=$(files_missing 'nextRouteForContract\(')
report "$ALLOWLIST" "$v1_violators" \
  "under pages/api/v1 are missing nextRouteForContract" \
  "Fix: route through nextRouteForContract (see b4m-core/common/src/api-contract/README.md).
Do NOT add to the allowlist -- this file is for permanent exceptions, not new handlers." || failed=1

JWT_ONLY="^[[:space:]]*([^/*[:space:]].*)?auth:[[:space:]]*['\"]jwtOnly['\"]"

# Scan 2: files outside v1 that do not declare auth: 'jwtOnly'. Same known limit as scan 1:
# a literal on a line starting with a comment marker (//, /*, *) does not count; a trailing
# comment or a string literal still does. Contract-routed jwtOnly handlers
# have no literal in the handler file and live on the baseline.
list_files "$API_ROOT" -path "$API_DIR" -prune -o
outside_violators=$(files_missing "$JWT_ONLY")
report "$ALLOWLIST_API_KEY" "$outside_violators" \
  "outside pages/api/v1 do not declare auth: 'jwtOnly' (so may accept API keys)" \
  "Fix: add auth: 'jwtOnly' to the handler, or, if it is a genuinely public endpoint, expose it
under /api/v1 behind a contract (CONVENTIONS.md: unversioned /api/* is frozen).
Last resort (e.g. a deliberately unauthenticated auth: false route, which has no jwtOnly
form): add it to $ALLOWLIST_API_KEY with a trailing '# reason'." || failed=1

# Scan 3: key-accepting handlers (v1 included) that call an LLM but name no billing seam.
# Known limit: only a direct call in the handler file counts, so an LLM reached through a
# helper (e.g. server/ai/refineTextRequest.ts) is metered in that helper, not checked here.
LLM_CALL='getOperationsModel\(|getLlmByModel\(|resolveDeepAgentBackend\(|\.complete\('
BILLING_SEAM='meterCompletionBackend\(|createRequestCompletionMeter\(|reserveCompletionCredits\(|reserveRequestCredits\(|createCompletionMeter\('
list_files "$API_ROOT"
unmetered_violators=$(files_matching_without "$LLM_CALL" "$JWT_ONLY" "$BILLING_SEAM")
report "$ALLOWLIST_UNMETERED" "$unmetered_violators" \
  "accept API keys and call an LLM without credit metering" \
  "Fix: meter the call (meterCompletionBackend + createRequestCompletionMeter, or
reserveCompletionCredits + settleCompletion; see apps/client/server/billing/meterPlatformCompletion.ts),
or, for an SPA-only helper, add auth: 'jwtOnly'. Do NOT add to $ALLOWLIST_UNMETERED." || failed=1

# Scan 4: Functions in infra/ with a Function URL whose handler is not built on
# defineLambdaRoute. The helper is a dependency-free node script (repo-guards installs
# nothing); it exits 2 when it cannot read a declaration, which must fail the gate.
# Every entry in this baseline needs a reason: the file starts empty, so it is not the
# place for an undocumented exemption.
reasonless=$(
  grep -v '^[[:space:]]*#' "$ALLOWLIST_FUNCTION_URL" | grep -v '^[[:space:]]*$' |
    grep -v '#[[:space:]]*[^[:space:]]' || true
)
if [ -n "$reasonless" ]; then
  echo "::error::allowlist entries in $ALLOWLIST_FUNCTION_URL are missing a '# reason' -- see job log"
  echo ""
  echo "ERROR: every entry in $ALLOWLIST_FUNCTION_URL needs a trailing '# reason':"
  echo "$reasonless" | sed 's/^/  /'
  echo ""
  exit 1
fi

url_status=0
url_violators=$(node "$SCRIPT_DIR/check-function-url-contracts.mjs" "$PWD") || url_status=$?
# A real exit 1 always printed a path; node also exits 1 for a throw or a load error, with no stdout.
if [ "$url_status" -gt 1 ] || { [ "$url_status" -eq 1 ] && [ -z "$url_violators" ]; }; then
  echo "::error::Function URL contract scan failed (exit ${url_status})"
  echo "ERROR: Could not scan $INFRA_DIR for Function URLs; refusing to report a clean result."
  exit 1
fi

report "$ALLOWLIST_FUNCTION_URL" "$url_violators" \
  "have an infra/ Function URL handler that is not built on defineLambdaRoute" \
  "Fix: build the handler on defineLambdaRoute(contract, handler) so it validates the request and
authenticates; then add the contract to contracts/index.ts and regenerate the spec, which is
what registers it in the OpenAPI spec (see b4m-core/common/src/api-contract/README.md).
Do NOT add to $ALLOWLIST_FUNCTION_URL for new code: entries there are frozen debt, and each
needs a trailing '# reason'." || failed=1

if [ "$failed" -eq 0 ]; then
  echo "OK: No contract-gate violations."
fi
exit "$failed"

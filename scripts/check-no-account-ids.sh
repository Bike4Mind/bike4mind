#!/usr/bin/env bash
# Open-core guard: fails if shippable code contains account-tied identifiers that
# must come from config/env instead (issue #9306, §8.3/§8.5).
#
# Detected categories:
#   - configured brand domains & emails (via DENY_BRAND_DOMAINS) + fallback-brand couplings
#   - Stripe price_/prod_ IDs
#   - Google Analytics measurement IDs (G-XXXX, UA-XXXX)
#   - AWS account IDs in ECR registry URLs + configured cross-account principals (via DENY_ACCOUNT_IDS)
#   - bare 24-character hex Mongo ObjectIds (user, org and document ids)
#
# Also serves as the before/after evidence for the security review: run it on the
# base ref to capture the violations, then on the fix branch to prove they're gone.
#
# To add a legitimate exception (e.g. an RFC-6761 .invalid domain, a doc link in a
# comment, a test fixture):
#   1. Add an extended-regex pattern to scripts/account-ids-allowlist.txt
#   2. Add a comment explaining why the match is acceptable

set -euo pipefail

ALLOWLIST="scripts/account-ids-allowlist.txt"

# Shippable code only. Docs-site branding is a separate milestone decision.
SCAN_DIRS=(apps b4m-core packages infra .github/workflows)

INCLUDES=(--include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx'
  --include='*.mjs' --include='*.cjs' --include='*.json' --include='*.yml' --include='*.yaml')

# Test fixtures and seed data legitimately reference example domains/emails and do
# not couple a fork to Bike4Mind infrastructure — the functional open-core risk is
# in runtime/infra/CI code. Excluded here; branding-in-tests is a separate concern.
EXCLUDE_FILES=(--exclude='*.test.ts' --exclude='*.test.tsx' --exclude='*.spec.ts'
  --exclude='*.spec.tsx' --exclude='*.test.js' --exclude='*.spec.js')

EXCLUDE_DIRS=(--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build
  --exclude-dir=.next --exclude-dir=.turbo --exclude-dir=coverage --exclude-dir=__tests__
  --exclude-dir=seeders --exclude-dir=out)

# Scope (issue #9306, §8.3/§8.5): account-tied identifiers that functionally couple
# a fork to Bike4Mind infrastructure — NOT general brand copy. Genericizing
# marketing/doc/logo text is a separate product-metaphor decision (milestone-level).
#
# ALWAYS_PATTERN: identifiers that are never legitimate brand copy — Stripe IDs, GA
# properties, and ECR registry URLs. The real AWS account IDs and the company email
# domain are NOT embedded in this script (it ships in the source tree, and hardcoding
# them here would be the very leak this guard exists to prevent — it also exempts its
# own scripts/ dir from the scan). They come from CI config instead:
#   DENY_ACCOUNT_IDS   — pipe-joined account IDs,   e.g. "111111111111|222222222222"
#   DENY_BRAND_DOMAINS — pipe-joined ERE domains,   e.g. "example\.com"
# Set both as repo/org variables on the private source repo (wired into ci.yml).
# Unset (e.g. on a public fork) simply skips those two checks - a fork has no B4M
# account IDs to catch, so there is nothing to protect there.
#
# A bare 24-character lowercase hex run is a Mongo ObjectId as `toString()` renders it, so it is
# a user, org or document id pasted into source - the shape CLAUDE.md answers with "resolve at
# runtime". It is narrow enough to be safe: a 40-char git SHA or any longer hash has no word
# boundary at 24, and every legitimate occurrence in this tree is a doc example or a vendored
# bundle, allowlisted by path. A narrower pattern was measured and does not work - real ids
# appear as plain property values under keys like `id`, never beside `userId`/`owners` and never
# as a module-scope const, so keyword- and const-scoped variants catch nothing at all.
#
# LIMITATION: EXCLUDE_FILES drops *.test.ts and *.spec.ts, where synthetic ids are legitimate and
# numerous - lifting that exclusion adds 242 matches across 83 files. So an id pasted into a test
# file still gets past this gate, and review is the only backstop there.
_alts=('price_[A-Za-z0-9]{10,}' 'prod_[A-Za-z0-9]{10,}' '\bG-[A-Z0-9]{8,}\b' '\bUA-[0-9]{4,}-[0-9]+\b' '[0-9]{12}\.dkr\.ecr\.' '\b[0-9a-f]{24}\b')
if [ -n "${DENY_ACCOUNT_IDS:-}" ]; then _alts+=("\\b(${DENY_ACCOUNT_IDS})\\b"); fi
if [ -n "${DENY_BRAND_DOMAINS:-}" ]; then _alts+=("(${DENY_BRAND_DOMAINS})"); fi
ALWAYS_PATTERN="($(IFS='|'; printf '%s' "${_alts[*]}"))"

# FALLBACK_PATTERN: a bike4mind.com literal used as a default/fallback (the §8.5
# "no brand fallback" couplings) — flagged only with a fallback operator so plain
# branding copy is left for the separate genericization decision.
#
# LIMITATION: grep is line-oriented, so this only catches single-line fallbacks
# (`X || 'app.bike4mind.com'`). A multi-line ternary fallback
# (`X\n  ? a\n  : 'app.bike4mind.com'`) would NOT be flagged, nor would a bare
# brand literal with no operator (those are the deferred-genericization category).
# Code review remains the backstop for those shapes; this gate stops the common case.
FALLBACK_PATTERN='bike4mind\.com.*(\|\||\?\?|:-|:=)|(\|\||\?\?|:-|:=).*bike4mind\.com'

if [ ! -f "$ALLOWLIST" ]; then
  echo "❌ ERROR: Allowlist not found at $ALLOWLIST"
  exit 1
fi

# Skip blank lines and comments; each remaining line is an ERE allow pattern.
allow_patterns=$(grep -vE '^[[:space:]]*(#|$)' "$ALLOWLIST" || true)

raw_findings=$(grep -rEn "${INCLUDES[@]}" "${EXCLUDE_FILES[@]}" "${EXCLUDE_DIRS[@]}" \
  -e "$ALWAYS_PATTERN" -e "$FALLBACK_PATTERN" "${SCAN_DIRS[@]}" 2>/dev/null || true)

# The scan walks the filesystem, so it also reaches git-ignored local artifacts - e2e auth
# state, probe manifests - which hold real ids by design and can never be committed. Drop
# them here rather than naming each directory, so a new kind of local artifact does not fail
# every contributor's next commit. A check-ignore error takes the same branch as "not
# ignored", keeping the guard loud rather than silently permissive.
if [ -n "$raw_findings" ]; then
  raw_findings=$(printf '%s\n' "$raw_findings" | while IFS= read -r line; do
    git check-ignore -q -- "${line%%:*}" || printf '%s\n' "$line"
  done)
fi

if [ -n "$allow_patterns" ] && [ -n "$raw_findings" ]; then
  findings=$(echo "$raw_findings" | grep -vEf <(echo "$allow_patterns") || true)
else
  findings="$raw_findings"
fi

if [ -n "$findings" ]; then
  echo "❌ ERROR: account-tied identifiers found in shippable code (issue #9306):"
  echo ""
  echo "$findings" | sed 's/^/  /'
  echo ""
  echo "Fix options:"
  echo "  1. Move the value to config/env with NO brand fallback (see requireEnv() in @bike4mind/common), OR"
  echo "  2. If the match is legitimate, add an allow pattern to $ALLOWLIST with a comment"
  exit 1
fi

echo "✅ No account-tied identifiers in shippable code."

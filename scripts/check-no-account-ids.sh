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
#   DENY_PARTNER_NAMES - pipe-joined ERE names,     e.g. "acme|globex"
# Set all three as repo/org variables on the private source repo (wired into ci.yml).
# Unset (e.g. on a public fork) simply skips those checks - a fork has no B4M
# account IDs to catch, so there is nothing to protect there.
#
# DENY_PARTNER_NAMES matches case-insensitively and on word boundaries, so a name that
# is also a common substring does not fire on every unrelated identifier that contains
# it. Sample data in a fixture is the usual way one of these gets in: a name with
# irregular capitalisation makes a normalizer's behaviour vivid in a test, which is
# exactly why someone reaches for a real one. Use an invented name instead.
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

# Partner names get their own pass rather than joining the alternation above, for two
# reasons. It is case-insensitive, because a name is written every way a person types it
# and the spelling worth catching is the one nobody looked for - but folding case over the
# alternation above would make `\bG-[A-Z0-9]{8,}\b` match `g-` as well, which fires on
# every minified bundle in the tree. And it skips packages/premium, where the private
# overlay repos are checked out in-tree: none of their content is tracked here, they
# legitimately name partners in their own private history, and including them would fail
# this hook for every developer who has one checked out.
#
# EXCLUDE_FILES applies here too, and for a name it bites harder than elsewhere: sample
# data in a fixture is the usual way one of these gets in, because a name with irregular
# capitalisation makes a normalizer's behaviour vivid in an assertion. So this arm covers
# shippable code and leaves the likeliest hiding place to review. Use an invented name.
if [ -n "${DENY_PARTNER_NAMES:-}" ]; then
  partner_findings=$(grep -rEni "${INCLUDES[@]}" "${EXCLUDE_FILES[@]}" "${EXCLUDE_DIRS[@]}" \
    --exclude-dir=premium -e "\\b(${DENY_PARTNER_NAMES})\\b" "${SCAN_DIRS[@]}" 2>/dev/null || true)
  raw_findings=$(printf '%s\n%s\n' "$raw_findings" "$partner_findings" | grep -v '^$' || true)
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

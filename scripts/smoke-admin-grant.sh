#!/usr/bin/env bash
# Smoke-test the admin-grant lifecycle introduced by issue #8366.
#
# Exercises: grant → top-up → adjust-seats → convert-to-paid → revoke.
# Reusable against any env (local / preview / staging) via BASE_URL and a
# super-admin session cookie.
#
# Usage:
#   BASE_URL=https://app.pr8415.preview.bike4mind.com \
#   COOKIE='session=…; otherCookie=…' \
#     ./scripts/smoke-admin-grant.sh
#
# Optional:
#   OWNER_EMAIL  — defaults to test@test.com (the seeded super-admin)
#   SKIP_CONVERT — set to "1" to skip the Stripe-touching convert-to-paid step
#
# Exit codes: 0 = all checks passed, 1 = a step failed.

set -euo pipefail

command -v jq >/dev/null 2>&1 || {
  echo "error: jq is required but not installed (brew install jq / apt-get install jq)" >&2
  exit 2
}

BASE_URL="${BASE_URL:?BASE_URL is required, e.g. https://app.pr8415.preview.bike4mind.com}"
COOKIE="${COOKIE:?COOKIE is required — copy the document.cookie value from a logged-in admin browser session}"
OWNER_EMAIL="${OWNER_EMAIL:-test@test.com}"
SKIP_CONVERT="${SKIP_CONVERT:-0}"

TS=$(date +%s)
ORG_NAME="Smoke ${TS}"
REASON="admin-grant smoke (${TS})"

pass() { printf '\033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m  %s\n     %s\n' "$1" "$2"; exit 1; }
info() { printf '       %s\n' "$1"; }

curl_admin() {
  curl --silent --show-error --fail-with-body \
    -H 'Content-Type: application/json' \
    -H "Cookie: ${COOKIE}" \
    "$@"
}

echo "→ BASE_URL=${BASE_URL}"
echo "→ Owner email: ${OWNER_EMAIL}"
echo

# ── 1. Grant ────────────────────────────────────────────────────────────────
GRANT_BODY=$(jq -n \
  --arg name "$ORG_NAME" \
  --arg email "$OWNER_EMAIL" \
  --arg reason "$REASON" \
  '{name:$name, ownerEmail:$email, seats:4, initialCredits:50000, reason:$reason}')

GRANT_RESPONSE=$(curl_admin -X POST "${BASE_URL}/api/admin/organizations/grant" -d "$GRANT_BODY") \
  || fail "POST /api/admin/organizations/grant" "$GRANT_RESPONSE"

ORG_ID=$(jq -r '.organizationId' <<<"$GRANT_RESPONSE")
[[ "$ORG_ID" != "null" && -n "$ORG_ID" ]] \
  || fail "grant response missing organizationId" "$GRANT_RESPONSE"

pass "grant created org ${ORG_ID} (${ORG_NAME})"

# ── 2. Verify granted listing ───────────────────────────────────────────────
GRANTS=$(curl_admin "${BASE_URL}/api/admin/organizations/grants")
echo "$GRANTS" | jq -e --arg id "$ORG_ID" '.grants[] | select(.ownerId == $id)' >/dev/null \
  || fail "GET /api/admin/organizations/grants — new org not present" "$GRANTS"
pass "new org appears in /grants list"

# ── 3. Top up ───────────────────────────────────────────────────────────────
TOPUP_KEY="smoke-${TS}-$$"
TOPUP=$(curl_admin -X POST "${BASE_URL}/api/admin/organizations/${ORG_ID}/top-up" \
  -d "{\"credits\":25000, \"reason\":\"smoke topup\", \"idempotencyKey\":\"${TOPUP_KEY}\"}")
ADDED=$(jq -r '.creditsAdded' <<<"$TOPUP")
[[ "$ADDED" == "25000" ]] || fail "top-up returned unexpected creditsAdded" "$TOPUP"
pass "top-up added 25000 credits"

# ── 4. Adjust seats ─────────────────────────────────────────────────────────
SEATS=$(curl_admin -X PATCH "${BASE_URL}/api/admin/organizations/${ORG_ID}/seats" \
  -d '{"seats":5}')
NEW_SEATS=$(jq -r '.seats' <<<"$SEATS")
[[ "$NEW_SEATS" == "5" ]] || fail "PATCH /seats returned unexpected seats" "$SEATS"
pass "seats updated to 5"

# ── 5. Convert to paid (Stripe-touching) ────────────────────────────────────
if [[ "$SKIP_CONVERT" == "1" ]]; then
  info "SKIP_CONVERT=1 → skipping convert-to-paid"
else
  CONVERT=$(curl_admin -X POST "${BASE_URL}/api/admin/organizations/${ORG_ID}/convert-to-paid" \
    -d "{\"callbackUrl\":\"${BASE_URL}/admin?tab=organizations\"}")
  CHECKOUT_URL=$(jq -r '.checkoutUrl' <<<"$CONVERT")
  [[ "$CHECKOUT_URL" == https://checkout.stripe.com/* ]] \
    || fail "convert-to-paid did not return a Stripe checkout URL" "$CONVERT"
  pass "convert-to-paid returned checkout URL"
  info "checkout: ${CHECKOUT_URL}"
  info "(complete the checkout in a browser to fire the webhook conversion flip)"
fi

# ── 6. Revoke ───────────────────────────────────────────────────────────────
REVOKE=$(curl_admin -X POST "${BASE_URL}/api/admin/organizations/${ORG_ID}/revoke" \
  -d '{"reason":"smoke cleanup"}')
STATUS=$(jq -r '.status' <<<"$REVOKE")
[[ "$STATUS" == "canceled" ]] || fail "revoke returned unexpected status" "$REVOKE"
pass "revoke set status=canceled"

echo
echo "✅ All checks passed against ${BASE_URL}"
echo "   Org id: ${ORG_ID}"

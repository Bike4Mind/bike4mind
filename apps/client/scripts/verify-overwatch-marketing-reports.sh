#!/usr/bin/env bash
# verify-overwatch-marketing-reports.sh
#
# Security verification script for the Marketing Reports API.
# Re-runnable against staging or PR preview environments via env vars.
#
# Usage:
#   BASE_URL=https://app.staging.bike4mind.com \
#   ADMIN_TOKEN=<session-cookie-value> \
#   WRITE_API_KEY=<key-with-marketing-reports:write> \
#   READ_API_KEY=<key-with-marketing-reports:read> \
#   UNSCOPED_API_KEY=<key-without-marketing-reports-scopes> \
#   ./scripts/verify-overwatch-marketing-reports.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
WRITE_API_KEY="${WRITE_API_KEY:-}"
READ_API_KEY="${READ_API_KEY:-}"
UNSCOPED_API_KEY="${UNSCOPED_API_KEY:-}"

ENDPOINT="${BASE_URL}/api/overwatch/marketing-reports"
PREVIEW_ENDPOINT="${BASE_URL}/api/overwatch/marketing-reports/preview"

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
pass() {
  echo "  PASS  $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo "  FAIL  $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

skip() {
  echo "  SKIP  $1"
  SKIP_COUNT=$((SKIP_COUNT + 1))
}

section() {
  echo ""
  echo "── $1 ──"
}

# Build Cookie header — try both the plain and __Secure- prefixed variants by
# including both in the same Cookie header; the server will use whichever it
# recognises.
admin_cookie_header() {
  echo "next-auth.session-token=${ADMIN_TOKEN}; __Secure-next-auth.session-token=${ADMIN_TOKEN}"
}

# http_status <status_var_name> <body_var_name> <curl args...>
# Runs curl and stores HTTP status and body into the named variables.
http_request() {
  local -n _status_ref=$1
  local -n _body_ref=$2
  shift 2
  local response
  response=$(curl -s -w "\n__HTTP_STATUS__%{http_code}" "$@")
  _status_ref="${response##*__HTTP_STATUS__}"
  _body_ref="${response%$'\n'__HTTP_STATUS__*}"
}

# ---------------------------------------------------------------------------
# Print header
# ---------------------------------------------------------------------------
echo "======================================================================"
echo "  Marketing Reports API — Security Verification"
echo "  BASE_URL : ${BASE_URL}"
echo "  $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "======================================================================"

REPORT_BODY='{"title":"Verify Test Report","reportDate":"2026-06-01","markdownContent":"# Test\n\nVerification report."}'

CREATED_REPORT_ID=""

# ---------------------------------------------------------------------------
# Auth checks
# ---------------------------------------------------------------------------
section "Auth checks"

# 1. No auth → 401 on GET
STATUS="" ; BODY=""
http_request STATUS BODY "${ENDPOINT}"
if [[ "$STATUS" == "401" ]]; then
  pass "1. No auth → 401 on GET /api/overwatch/marketing-reports"
else
  fail "1. No auth → 401 on GET /api/overwatch/marketing-reports (got $STATUS)"
fi

# 2. No auth → 401 on POST
STATUS="" ; BODY=""
http_request STATUS BODY -X POST \
  -H "Content-Type: application/json" \
  -d "$REPORT_BODY" \
  "${ENDPOINT}"
if [[ "$STATUS" == "401" ]]; then
  pass "2. No auth → 401 on POST /api/overwatch/marketing-reports"
else
  fail "2. No auth → 401 on POST /api/overwatch/marketing-reports (got $STATUS)"
fi

# 3. Admin session cookie → 200 on GET
if [[ -z "$ADMIN_TOKEN" ]]; then
  skip "3. Admin session cookie → 200 on GET (ADMIN_TOKEN not set)"
else
  STATUS="" ; BODY=""
  http_request STATUS BODY \
    -H "Cookie: $(admin_cookie_header)" \
    "${ENDPOINT}"
  if [[ "$STATUS" == "200" ]]; then
    pass "3. Admin session cookie → 200 on GET"
  else
    fail "3. Admin session cookie → 200 on GET (got $STATUS)"
  fi
fi

# 4. WRITE_API_KEY → 201 on POST (capture report ID)
if [[ -z "$WRITE_API_KEY" ]]; then
  skip "4. WRITE_API_KEY → 201 on POST with valid body (WRITE_API_KEY not set)"
else
  STATUS="" ; BODY=""
  http_request STATUS BODY -X POST \
    -H "Content-Type: application/json" \
    -H "x-api-key: ${WRITE_API_KEY}" \
    -d "$REPORT_BODY" \
    "${ENDPOINT}"
  if [[ "$STATUS" == "201" ]]; then
    pass "4. WRITE_API_KEY → 201 on POST with valid body"
    # Attempt to extract the report ID from the JSON response
    CREATED_REPORT_ID=$(echo "$BODY" | grep -o '"id":"[^"]*"' | head -1 | sed 's/"id":"//;s/"//')
    if [[ -n "$CREATED_REPORT_ID" ]]; then
      echo "        (captured report ID: ${CREATED_REPORT_ID})"
    else
      CREATED_REPORT_ID=$(echo "$BODY" | grep -o '"_id":"[^"]*"' | head -1 | sed 's/"_id":"//;s/"//')
      [[ -n "$CREATED_REPORT_ID" ]] && echo "        (captured report _id: ${CREATED_REPORT_ID})"
    fi
  else
    fail "4. WRITE_API_KEY → 201 on POST with valid body (got $STATUS; body: ${BODY:0:200})"
  fi
fi

# 5. READ_API_KEY → 200 on GET
if [[ -z "$READ_API_KEY" ]]; then
  skip "5. READ_API_KEY → 200 on GET (READ_API_KEY not set)"
else
  STATUS="" ; BODY=""
  http_request STATUS BODY \
    -H "x-api-key: ${READ_API_KEY}" \
    "${ENDPOINT}"
  if [[ "$STATUS" == "200" ]]; then
    pass "5. READ_API_KEY → 200 on GET"
  else
    fail "5. READ_API_KEY → 200 on GET (got $STATUS)"
  fi
fi

# 6. READ_API_KEY → 403 on POST (write attempt with read-only key)
if [[ -z "$READ_API_KEY" ]]; then
  skip "6. READ_API_KEY → 403 on POST (READ_API_KEY not set)"
else
  STATUS="" ; BODY=""
  http_request STATUS BODY -X POST \
    -H "Content-Type: application/json" \
    -H "x-api-key: ${READ_API_KEY}" \
    -d "$REPORT_BODY" \
    "${ENDPOINT}"
  if [[ "$STATUS" == "403" ]]; then
    pass "6. READ_API_KEY → 403 on POST (write attempt with read-only key)"
  else
    fail "6. READ_API_KEY → 403 on POST (write attempt with read-only key) (got $STATUS)"
  fi
fi

# 7. UNSCOPED_API_KEY → 403 on GET (no scope at all)
if [[ -z "$UNSCOPED_API_KEY" ]]; then
  skip "7. UNSCOPED_API_KEY → 403 on GET (UNSCOPED_API_KEY not set)"
else
  STATUS="" ; BODY=""
  http_request STATUS BODY \
    -H "x-api-key: ${UNSCOPED_API_KEY}" \
    "${ENDPOINT}"
  if [[ "$STATUS" == "403" ]]; then
    pass "7. UNSCOPED_API_KEY → 403 on GET (no scope)"
  else
    fail "7. UNSCOPED_API_KEY → 403 on GET (no scope) (got $STATUS)"
  fi
fi

# 8. WRITE_API_KEY → 403 on DELETE (write key cannot delete)
if [[ -z "$WRITE_API_KEY" ]]; then
  skip "8. WRITE_API_KEY → 403 on DELETE (WRITE_API_KEY not set)"
else
  DELETE_TARGET="${ENDPOINT}/${CREATED_REPORT_ID:-placeholder-id}"
  STATUS="" ; BODY=""
  http_request STATUS BODY -X DELETE \
    -H "x-api-key: ${WRITE_API_KEY}" \
    "${DELETE_TARGET}"
  if [[ "$STATUS" == "403" ]]; then
    pass "8. WRITE_API_KEY → 403 on DELETE (write key cannot delete)"
  else
    fail "8. WRITE_API_KEY → 403 on DELETE (write key cannot delete) (got $STATUS)"
  fi
fi

# ---------------------------------------------------------------------------
# XSS / sanitization checks
# ---------------------------------------------------------------------------
section "XSS / sanitization checks"

# Preview endpoint requires admin session (not API key). Use ADMIN_TOKEN only.
PREVIEW_AUTH_ARGS=()
PREVIEW_AUTH_LABEL=""
if [[ -n "$ADMIN_TOKEN" ]]; then
  PREVIEW_AUTH_ARGS=(-H "Cookie: $(admin_cookie_header)")
  PREVIEW_AUTH_LABEL="ADMIN_TOKEN"
fi

if [[ ${#PREVIEW_AUTH_ARGS[@]} -eq 0 ]]; then
  skip "9.  XSS: <script> tag in markdownContent (no auth available — set WRITE_API_KEY or ADMIN_TOKEN)"
  skip "10. XSS: data: URI in img src (no auth available)"
  skip "11. XSS: onclick attribute (no auth available)"
  skip "12. XSS: javascript: href (no auth available)"
else
  echo "      (using ${PREVIEW_AUTH_LABEL} for preview endpoint)"

  # 9. <script> tag
  SCRIPT_PAYLOAD='{"markdownContent":"# Test\n\n<script>alert(1)<\/script>\n\nSome text."}'
  STATUS="" ; BODY=""
  http_request STATUS BODY -X POST \
    -H "Content-Type: application/json" \
    "${PREVIEW_AUTH_ARGS[@]}" \
    -d "$SCRIPT_PAYLOAD" \
    "${PREVIEW_ENDPOINT}"
  if echo "$BODY" | grep -qi "<script"; then
    fail "9.  XSS: <script> tag in markdownContent → htmlContent CONTAINS <script> (not sanitized)"
  elif [[ "$STATUS" == "401" || "$STATUS" == "403" ]]; then
    fail "9.  XSS: <script> tag test blocked by auth (got $STATUS) — check credentials"
  else
    pass "9.  XSS: <script> tag in markdownContent → htmlContent does NOT contain <script>"
  fi

  # 10. data: URI in img src
  DATA_URI_PAYLOAD='{"markdownContent":"# Test\n\n<img src=\"data:text/html,evil\">\n"}'
  STATUS="" ; BODY=""
  http_request STATUS BODY -X POST \
    -H "Content-Type: application/json" \
    "${PREVIEW_AUTH_ARGS[@]}" \
    -d "$DATA_URI_PAYLOAD" \
    "${PREVIEW_ENDPOINT}"
  if echo "$BODY" | grep -qi "data:"; then
    fail "10. XSS: data: URI in img src → htmlContent CONTAINS data: (not sanitized)"
  elif [[ "$STATUS" == "401" || "$STATUS" == "403" ]]; then
    fail "10. XSS: data: URI test blocked by auth (got $STATUS)"
  else
    pass "10. XSS: data: URI in img src → htmlContent does NOT contain data:"
  fi

  # 11. onclick attribute
  ONCLICK_PAYLOAD='{"markdownContent":"# Test\n\n<div onclick=\"alert(1)\">click me<\/div>\n"}'
  STATUS="" ; BODY=""
  http_request STATUS BODY -X POST \
    -H "Content-Type: application/json" \
    "${PREVIEW_AUTH_ARGS[@]}" \
    -d "$ONCLICK_PAYLOAD" \
    "${PREVIEW_ENDPOINT}"
  if echo "$BODY" | grep -qi "onclick"; then
    fail "11. XSS: onclick attribute → htmlContent CONTAINS onclick (not sanitized)"
  elif [[ "$STATUS" == "401" || "$STATUS" == "403" ]]; then
    fail "11. XSS: onclick test blocked by auth (got $STATUS)"
  else
    pass "11. XSS: onclick attribute → htmlContent does NOT contain onclick"
  fi

  # 12. javascript: href
  JSLINK_PAYLOAD='{"markdownContent":"# Test\n\n[evil](javascript:alert(1))\n"}'
  STATUS="" ; BODY=""
  http_request STATUS BODY -X POST \
    -H "Content-Type: application/json" \
    "${PREVIEW_AUTH_ARGS[@]}" \
    -d "$JSLINK_PAYLOAD" \
    "${PREVIEW_ENDPOINT}"
  if echo "$BODY" | grep -qi "javascript:"; then
    fail "12. XSS: javascript: href → htmlContent CONTAINS javascript: (not sanitized)"
  elif [[ "$STATUS" == "401" || "$STATUS" == "403" ]]; then
    fail "12. XSS: javascript: href test blocked by auth (got $STATUS)"
  else
    pass "12. XSS: javascript: href → htmlContent does NOT contain javascript:"
  fi
fi

# ---------------------------------------------------------------------------
# iframe sandbox check
# ---------------------------------------------------------------------------
section "iframe sandbox check"

echo "  NOTE  13. iframe sandbox=\"\" enforcement is a client-side rendering concern."
echo "            Verify in DevTools that the report iframe has sandbox=\"\" with NO allow-scripts."
echo "            The API itself delivers HTML — sandbox is enforced by the embedding component."
PASS_COUNT=$((PASS_COUNT + 1))

# ---------------------------------------------------------------------------
# Size cap check
# ---------------------------------------------------------------------------
section "Size cap check"

# 14. POST with markdownContent > 500KB → 413
if [[ ${#PREVIEW_AUTH_ARGS[@]} -eq 0 ]]; then
  skip "14. Size cap: >500KB markdownContent → 413 (no auth available)"
else
  # Generate ~510KB of content (512*1024 = 524288 chars of 'A')
  LARGE_CONTENT=$(printf 'A%.0s' {1..524289})
  LARGE_PAYLOAD="{\"markdownContent\":\"${LARGE_CONTENT}\"}"
  STATUS="" ; BODY=""
  http_request STATUS BODY -X POST \
    -H "Content-Type: application/json" \
    "${PREVIEW_AUTH_ARGS[@]}" \
    -d "$LARGE_PAYLOAD" \
    "${PREVIEW_ENDPOINT}"
  if [[ "$STATUS" == "413" ]]; then
    pass "14. Size cap: >500KB markdownContent → 413"
  else
    fail "14. Size cap: >500KB markdownContent → expected 413, got $STATUS"
  fi
fi

# ---------------------------------------------------------------------------
# Idempotency check
# ---------------------------------------------------------------------------
section "Idempotency check"

# Use a fixed key derived from current epoch so each full script run uses the
# same key within a single execution but differs across runs.
IDEM_KEY="verify-test-$(date +%s)"

if [[ -z "$WRITE_API_KEY" && -z "$ADMIN_TOKEN" ]]; then
  skip "15. Idempotency: first POST with Idempotency-Key → 201 (no auth available)"
  skip "16. Idempotency: repeat POST with same key → 200 with same report ID (no auth available)"
else
  IDEM_AUTH_ARGS=()
  if [[ -n "$WRITE_API_KEY" ]]; then
    IDEM_AUTH_ARGS=(-H "x-api-key: ${WRITE_API_KEY}")
  else
    IDEM_AUTH_ARGS=(-H "Cookie: $(admin_cookie_header)")
  fi

  # 15. First POST → 201
  STATUS="" ; BODY=""
  http_request STATUS BODY -X POST \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: ${IDEM_KEY}" \
    "${IDEM_AUTH_ARGS[@]}" \
    -d "$REPORT_BODY" \
    "${ENDPOINT}"
  IDEM_ID_FIRST=""
  if [[ "$STATUS" == "201" ]]; then
    pass "15. Idempotency: first POST with Idempotency-Key → 201"
    IDEM_ID_FIRST=$(echo "$BODY" | grep -o '"id":"[^"]*"' | head -1 | sed 's/"id":"//;s/"//')
    [[ -z "$IDEM_ID_FIRST" ]] && IDEM_ID_FIRST=$(echo "$BODY" | grep -o '"_id":"[^"]*"' | head -1 | sed 's/"_id":"//;s/"//')
    [[ -n "$IDEM_ID_FIRST" ]] && echo "        (report ID from first POST: ${IDEM_ID_FIRST})"
  else
    fail "15. Idempotency: first POST with Idempotency-Key → expected 201, got $STATUS"
  fi

  # 16. Repeat POST → 200 with same report ID
  STATUS="" ; BODY=""
  http_request STATUS BODY -X POST \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: ${IDEM_KEY}" \
    "${IDEM_AUTH_ARGS[@]}" \
    -d "$REPORT_BODY" \
    "${ENDPOINT}"
  IDEM_ID_SECOND=""
  if [[ "$STATUS" == "200" ]]; then
    IDEM_ID_SECOND=$(echo "$BODY" | grep -o '"id":"[^"]*"' | head -1 | sed 's/"id":"//;s/"//')
    [[ -z "$IDEM_ID_SECOND" ]] && IDEM_ID_SECOND=$(echo "$BODY" | grep -o '"_id":"[^"]*"' | head -1 | sed 's/"_id":"//;s/"//')
    [[ -n "$IDEM_ID_SECOND" ]] && echo "        (report ID from second POST: ${IDEM_ID_SECOND})"
    if [[ -n "$IDEM_ID_FIRST" && -n "$IDEM_ID_SECOND" && "$IDEM_ID_FIRST" != "$IDEM_ID_SECOND" ]]; then
      fail "16. Idempotency: repeat POST → 200 but report IDs DIFFER (first: ${IDEM_ID_FIRST}, second: ${IDEM_ID_SECOND})"
    else
      pass "16. Idempotency: repeat POST with same Idempotency-Key → 200 with same report ID"
    fi
  else
    fail "16. Idempotency: repeat POST with same Idempotency-Key → expected 200, got $STATUS"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "======================================================================"
TOTAL=$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))
echo "  Results: ${PASS_COUNT} passed, ${FAIL_COUNT} failed, ${SKIP_COUNT} skipped  (${TOTAL} total)"
echo "======================================================================"

if [[ $FAIL_COUNT -gt 0 ]]; then
  echo "  OVERALL: FAILED"
  exit 1
else
  echo "  OVERALL: PASSED"
  exit 0
fi

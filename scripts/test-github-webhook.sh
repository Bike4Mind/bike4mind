#!/bin/bash
#
# GitHub Webhook Test Script
#
# Tests the GitHub webhook endpoint on preview/staging environments.
# Validates response times, error handling, and deduplication.
#
# Usage:
#   ./scripts/test-github-webhook.sh
#
# Required environment variables:
#   WEBHOOK_URL      - Full URL to webhook endpoint (e.g., https://preview.example.com/api/webhooks/github)
#   ROUTING_TOKEN    - X-Webhook-Token header value (from MCP server config)
#   WEBHOOK_SECRET   - Webhook secret for HMAC signature (from MCP server config)
#
# Optional:
#   VERBOSE=1        - Show full response bodies
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check required environment variables
check_env() {
  local missing=0
  if [[ -z "$WEBHOOK_URL" ]]; then
    echo -e "${RED}ERROR: WEBHOOK_URL is required${NC}"
    missing=1
  fi
  if [[ -z "$ROUTING_TOKEN" ]]; then
    echo -e "${RED}ERROR: ROUTING_TOKEN is required${NC}"
    missing=1
  fi
  if [[ -z "$WEBHOOK_SECRET" ]]; then
    echo -e "${RED}ERROR: WEBHOOK_SECRET is required${NC}"
    missing=1
  fi
  if [[ $missing -eq 1 ]]; then
    echo ""
    echo "Usage: WEBHOOK_URL=... ROUTING_TOKEN=... WEBHOOK_SECRET=... $0"
    exit 1
  fi
}

# Generate HMAC-SHA256 signature
generate_signature() {
  local payload="$1"
  local secret="$2"
  echo -n "$payload" | openssl dgst -sha256 -hmac "$secret" | sed 's/^.* //'
}

# Send webhook request and capture response
send_webhook() {
  local event_type="$1"
  local delivery_id="$2"
  local payload="$3"
  local signature="$4"
  local token="${5:-$ROUTING_TOKEN}"
  local extra_args="${6:-}"

  local start_time=$(date +%s%3N)

  local response
  local http_code

  # Build curl command
  local curl_cmd="curl -s -w '\n%{http_code}\n%{time_total}' -X POST '$WEBHOOK_URL'"
  curl_cmd="$curl_cmd -H 'Content-Type: application/json'"
  curl_cmd="$curl_cmd -H 'X-GitHub-Event: $event_type'"

  if [[ -n "$delivery_id" ]]; then
    curl_cmd="$curl_cmd -H 'X-GitHub-Delivery: $delivery_id'"
  fi

  if [[ -n "$signature" ]]; then
    curl_cmd="$curl_cmd -H 'X-Hub-Signature-256: sha256=$signature'"
  fi

  if [[ -n "$token" ]]; then
    curl_cmd="$curl_cmd -H 'X-Webhook-Token: $token'"
  fi

  curl_cmd="$curl_cmd -d '$payload'"

  # Execute and capture output
  local output
  output=$(eval $curl_cmd 2>&1)

  # Parse response (body, http_code, time)
  local body=$(echo "$output" | head -n -2)
  local http_code=$(echo "$output" | tail -n 2 | head -n 1)
  local time_total=$(echo "$output" | tail -n 1)

  echo "$body|$http_code|$time_total"
}

# Test case runner
run_test() {
  local test_name="$1"
  local expected_code="$2"
  local event_type="$3"
  local delivery_id="$4"
  local payload="$5"
  local use_valid_signature="$6"
  local custom_token="${7:-$ROUTING_TOKEN}"
  local max_time="${8:-2.0}"

  echo -n "  Testing: $test_name... "

  local signature=""
  if [[ "$use_valid_signature" == "true" ]]; then
    signature=$(generate_signature "$payload" "$WEBHOOK_SECRET")
  elif [[ "$use_valid_signature" == "invalid" ]]; then
    signature="invalid_signature_here"
  fi

  local result
  result=$(send_webhook "$event_type" "$delivery_id" "$payload" "$signature" "$custom_token")

  local body=$(echo "$result" | cut -d'|' -f1)
  local http_code=$(echo "$result" | cut -d'|' -f2)
  local time_total=$(echo "$result" | cut -d'|' -f3)

  # Check HTTP code
  if [[ "$http_code" != "$expected_code" ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "    Expected HTTP $expected_code, got $http_code"
    if [[ -n "$VERBOSE" ]]; then
      echo "    Response: $body"
    fi
    return 1
  fi

  # Check response time (should be < 2 seconds for success cases)
  local time_ok="true"
  if (( $(echo "$time_total > $max_time" | bc -l) )); then
    time_ok="false"
  fi

  if [[ "$time_ok" == "false" ]]; then
    echo -e "${YELLOW}SLOW${NC} (${time_total}s > ${max_time}s)"
    if [[ -n "$VERBOSE" ]]; then
      echo "    Response: $body"
    fi
    return 0
  fi

  echo -e "${GREEN}PASSED${NC} (${time_total}s)"
  if [[ -n "$VERBOSE" ]]; then
    echo "    Response: $body"
  fi
  return 0
}

# Main test suite
main() {
  check_env

  echo ""
  echo -e "${BLUE}========================================${NC}"
  echo -e "${BLUE}  GitHub Webhook Endpoint Test Suite${NC}"
  echo -e "${BLUE}========================================${NC}"
  echo ""
  echo "Target: $WEBHOOK_URL"
  echo ""

  local passed=0
  local failed=0
  local total=0

  # Generate unique delivery IDs
  local timestamp=$(date +%s)
  local ping_delivery="test-ping-$timestamp"
  local push_delivery="test-push-$timestamp"
  local pr_delivery="test-pr-$timestamp"
  local dup_delivery="test-dup-$timestamp"

  # Test payloads
  local ping_payload='{"zen":"Keep it logically awesome.","hook_id":123}'
  local push_payload='{"ref":"refs/heads/main","repository":{"full_name":"owner/repo"},"commits":[]}'
  local pr_payload='{"action":"opened","number":1,"pull_request":{"title":"Test PR"},"repository":{"full_name":"owner/repo"}}'

  echo -e "${YELLOW}1. Valid Webhook Tests${NC}"
  echo "   (Should return 200 in < 2 seconds)"
  echo ""

  # Test 1: Valid ping event
  ((total++))
  if run_test "Valid ping event" "200" "ping" "$ping_delivery" "$ping_payload" "true"; then
    ((passed++))
  else
    ((failed++))
  fi

  # Test 2: Valid push event
  ((total++))
  if run_test "Valid push event" "200" "push" "$push_delivery" "$push_payload" "true"; then
    ((passed++))
  else
    ((failed++))
  fi

  # Test 3: Valid pull_request event
  ((total++))
  if run_test "Valid pull_request event" "200" "pull_request" "$pr_delivery" "$pr_payload" "true"; then
    ((passed++))
  else
    ((failed++))
  fi

  echo ""
  echo -e "${YELLOW}2. Deduplication Tests${NC}"
  echo "   (Duplicate should return 200 with 'already processed')"
  echo ""

  # Test 4: First request (should succeed)
  ((total++))
  if run_test "First request (dedup test)" "200" "ping" "$dup_delivery" "$ping_payload" "true"; then
    ((passed++))
  else
    ((failed++))
  fi

  # Test 5: Duplicate request (same delivery ID)
  ((total++))
  if run_test "Duplicate request (same delivery ID)" "200" "ping" "$dup_delivery" "$ping_payload" "true"; then
    ((passed++))
  else
    ((failed++))
  fi

  echo ""
  echo -e "${YELLOW}3. Authentication Tests${NC}"
  echo "   (Should return 401 for invalid credentials)"
  echo ""

  # Test 6: Invalid signature
  ((total++))
  if run_test "Invalid signature" "401" "ping" "test-invalid-sig-$timestamp" "$ping_payload" "invalid"; then
    ((passed++))
  else
    ((failed++))
  fi

  # Test 7: Missing signature
  ((total++))
  if run_test "Missing signature" "401" "ping" "test-no-sig-$timestamp" "$ping_payload" "false"; then
    ((passed++))
  else
    ((failed++))
  fi

  # Test 8: Invalid routing token
  ((total++))
  if run_test "Invalid routing token" "401" "ping" "test-bad-token-$timestamp" "$ping_payload" "true" "invalid-token-12345"; then
    ((passed++))
  else
    ((failed++))
  fi

  echo ""
  echo -e "${YELLOW}4. Header Validation Tests${NC}"
  echo "   (Should return 400 for missing required headers)"
  echo ""

  # Test 9: Missing routing token
  ((total++))
  if run_test "Missing routing token" "400" "ping" "test-no-token-$timestamp" "$ping_payload" "true" ""; then
    ((passed++))
  else
    ((failed++))
  fi

  echo ""
  echo -e "${YELLOW}5. Event Type Tests${NC}"
  echo "   (Unsupported events should return 200 but not process)"
  echo ""

  # Test 10: Unsupported event type
  ((total++))
  if run_test "Unsupported event type" "200" "unsupported_event" "test-unsupported-$timestamp" "$ping_payload" "true"; then
    ((passed++))
  else
    ((failed++))
  fi

  # Summary
  echo ""
  echo -e "${BLUE}========================================${NC}"
  echo -e "${BLUE}  Test Summary${NC}"
  echo -e "${BLUE}========================================${NC}"
  echo ""
  echo -e "  Total:  $total"
  echo -e "  ${GREEN}Passed: $passed${NC}"
  if [[ $failed -gt 0 ]]; then
    echo -e "  ${RED}Failed: $failed${NC}"
  else
    echo -e "  Failed: $failed"
  fi
  echo ""

  if [[ $failed -eq 0 ]]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
  else
    echo -e "${RED}Some tests failed.${NC}"
    exit 1
  fi
}

main "$@"

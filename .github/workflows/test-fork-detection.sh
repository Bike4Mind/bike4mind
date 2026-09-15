#!/bin/bash
# Test script for fork detection logic
# Usage: bash .github/workflows/test-fork-detection.sh

set -e

echo "========================================="
echo "Fork Detection Logic Test Suite"
echo "========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counter
PASSED=0
FAILED=0

# Test function
test_detection() {
    local test_name="$1"
    local repo="$2"
    local author="$3"
    local message="$4"
    local expected_generate="$5"
    local expected_reason="$6"

    echo -e "${YELLOW}Test: $test_name${NC}"
    echo "  Repository: $repo"
    echo "  Author: $author"
    echo "  Message: $message"

    # Run detection logic (mimicking workflow)
    should_generate=""
    skip_reason=""
    is_main_repo="false"

    # Main repo check
    if [ "$repo" = "MillionOnMars/lumina5" ]; then
        should_generate="true"
        skip_reason="none"
        is_main_repo="true"
    else
        is_main_repo="false"
        is_synced=false

        # Detection signals
        if [ "$author" = "Fork Sync Bot" ]; then
            is_synced=true
            skip_reason="sync_bot_author"
        elif echo "$message" | grep -qi "synced from.*lumina5"; then
            is_synced=true
            skip_reason="sync_commit_message"
        elif echo "$message" | grep -qi "fork.sync"; then
            is_synced=true
            skip_reason="fork_sync_keyword"
        fi

        if [ "$is_synced" = true ]; then
            should_generate="false"
        else
            should_generate="true"
            skip_reason="none"
        fi
    fi

    # Validate results
    if [ "$should_generate" = "$expected_generate" ] && [ "$skip_reason" = "$expected_reason" ]; then
        echo -e "  ${GREEN}✓ PASS${NC}"
        echo "    Generated: $should_generate, Reason: $skip_reason"
        ((PASSED++))
    else
        echo -e "  ${RED}✗ FAIL${NC}"
        echo "    Expected: generate=$expected_generate, reason=$expected_reason"
        echo "    Got:      generate=$should_generate, reason=$skip_reason"
        ((FAILED++))
    fi
    echo ""
}

# Run test suite
echo "Running test suite..."
echo ""

# Test 1: Main repository always generates
test_detection \
    "Main repo always generates" \
    "MillionOnMars/lumina5" \
    "John Doe" \
    "Release v1.0.0" \
    "true" \
    "none"

# Test 2: Fork with sync bot author
test_detection \
    "Fork with Fork Sync Bot author" \
    "SomeUser/lumina5" \
    "Fork Sync Bot" \
    "Release v1.0.0" \
    "false" \
    "sync_bot_author"

# Test 3: Fork with sync in commit message
test_detection \
    "Fork with 'synced from lumina5' message" \
    "SomeUser/lumina5" \
    "Jane Smith" \
    "Release v1.0.0 synced from MillionOnMars/lumina5" \
    "false" \
    "sync_commit_message"

# Test 4: Fork with fork.sync keyword
test_detection \
    "Fork with fork.sync keyword" \
    "SomeUser/lumina5" \
    "Release Bot" \
    "Auto-release via fork.sync mechanism" \
    "false" \
    "fork_sync_keyword"

# Test 5: Fork with custom release
test_detection \
    "Fork with custom release" \
    "SomeUser/lumina5" \
    "Fork Maintainer" \
    "Add custom feature XYZ" \
    "true" \
    "none"

# Test 6: Fork with mixed case sync message
test_detection \
    "Fork with case-insensitive sync detection" \
    "SomeUser/lumina5" \
    "Bot" \
    "SYNCED FROM MILLIONONMARS/LUMINA5" \
    "false" \
    "sync_commit_message"

# Test 7: Fork with partial sync keyword
test_detection \
    "Fork with valid release but 'sync' in unrelated context" \
    "SomeUser/lumina5" \
    "Developer" \
    "Fix data synchronization issue" \
    "true" \
    "none"

# Summary
echo "========================================="
echo "Test Results"
echo "========================================="
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}✗ Some tests failed${NC}"
    exit 1
fi

#!/bin/bash
# Script to help review and remediate secrets found by gitleaks

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

echo "${YELLOW}Bike4Mind Secret Review Tool${NC}"
echo "This tool will help you find and fix secrets in the codebase."
echo ""

# Check if gitleaks is installed
if ! command -v gitleaks &> /dev/null; then
    echo "${RED}Error: gitleaks is not installed.${NC}"
    echo "Please install it first:"
    echo "  Mac: brew install gitleaks"
    echo "  Linux: sudo apt-get install gitleaks"
    exit 1
fi

# Check if jq is installed (needed for JSON parsing)
if ! command -v jq &> /dev/null; then
    echo "${RED}Error: jq is not installed.${NC}"
    echo "Please install it first:"
    echo "  Mac: brew install jq"
    echo "  Linux: sudo apt-get install jq"
    exit 1
fi

# Note about proper flag usage
echo "${YELLOW}Note: gitleaks requires double-dash for flags (--flag not -flag)${NC}"
echo "Example: gitleaks detect --verbose --redact"
echo ""

# Create a temporary directory
TEMP_DIR=$(mktemp -d)
REPORT_FILE="$TEMP_DIR/gitleaks-report.json"

echo "${YELLOW}Running gitleaks scan...${NC}"
echo "This will take a moment to scan the entire codebase."

# Try with main config first
if gitleaks detect --verbose --redact --path . --config-path .gitleaks.toml --report-path "$REPORT_FILE" --report-format json 2>/dev/null; then
    if [ ! -s "$REPORT_FILE" ]; then
        echo "${GREEN}No secrets detected! Your codebase is clean.${NC}"
        exit 0
    fi
elif [ $? -eq 2 ]; then
    # Config error, try simple config
    echo "${YELLOW}Main config error, trying simple config...${NC}"
    if [ -f ".gitleaks.toml.simple" ]; then
        if gitleaks detect --verbose --redact --path . --config-path .gitleaks.toml.simple --report-path "$REPORT_FILE" --report-format json 2>/dev/null; then
            if [ ! -s "$REPORT_FILE" ]; then
                echo "${GREEN}No secrets detected! Your codebase is clean.${NC}"
                exit 0
            fi
        else
            # Try default config
            echo "${YELLOW}Simple config error, trying default config...${NC}"
            gitleaks detect --verbose --redact --path . --report-path "$REPORT_FILE" --report-format json
            if [ ! -s "$REPORT_FILE" ]; then
                echo "${GREEN}No secrets detected! Your codebase is clean.${NC}"
                exit 0
            fi
        fi
    else
        # Try default config
        echo "${YELLOW}No simple config found, trying default config...${NC}"
        gitleaks detect --verbose --redact --path . --report-path "$REPORT_FILE" --report-format json
        if [ ! -s "$REPORT_FILE" ]; then
            echo "${GREEN}No secrets detected! Your codebase is clean.${NC}"
            exit 0
        fi
    fi
fi

# Count the total number of findings
TOTAL_FINDINGS=$(jq length "$REPORT_FILE")
echo "${RED}Found $TOTAL_FINDINGS potential secrets in the codebase.${NC}"

# Group findings by file
echo "${YELLOW}Grouping findings by file:${NC}"
jq -r '.[].File' "$REPORT_FILE" | sort | uniq -c | sort -rn | while read -r count file; do
    echo "- $file: $count findings"
done

echo ""
echo "${YELLOW}Grouping findings by type:${NC}"
jq -r '.[].RuleID' "$REPORT_FILE" | sort | uniq -c | sort -rn | while read -r count rule; do
    echo "- $rule: $count findings"
done

echo ""
echo "${YELLOW}Top files with secrets:${NC}"
jq -r '.[].File' "$REPORT_FILE" | sort | uniq -c | sort -rn | head -5 | while read -r count file; do
    echo "- $file: $count findings"
done

# Ask if user wants to see details for a specific file
echo ""
echo "${YELLOW}Would you like to see details for a specific file? (y/n)${NC}"
read -r answer

if [[ "$answer" =~ ^[Yy]$ ]]; then
    echo "${YELLOW}Enter the filename:${NC}"
    read -r filename

    echo "${YELLOW}Findings in $filename:${NC}"
    jq -r '.[] | select(.File == "'"$filename"'") | "Line \(.LineNumber): \(.Secret) [\(.RuleID)]"' "$REPORT_FILE"
    
    echo ""
    echo "${YELLOW}Remediation tips:${NC}"
    echo "1. Move sensitive values to SST Secrets: secrets.VARIABLE_NAME"
    echo "2. Update code to use environment variables: process.env.VARIABLE_NAME"
    echo "3. For client-side code, consider using API endpoints instead of hardcoded keys"
    echo "4. Remove any test/example secrets"
fi

# Clean up
rm -rf "$TEMP_DIR"

echo ""
echo "${YELLOW}For a full report on all findings, run:${NC}"
echo "gitleaks detect --verbose --redact --report-format json | jq ."
echo ""
echo "${GREEN}Happy fixing!${NC}" 
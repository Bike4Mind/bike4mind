#!/bin/sh

# Gitleaks pre-commit hook for Bike4Mind
# This hook prevents accidental commits of secrets

# Add common binary paths
export PATH="$PATH:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Get the full path to gitleaks
GITLEAKS_PATH=$(which gitleaks 2>/dev/null)
if [ -z "$GITLEAKS_PATH" ]; then
  echo "Error: gitleaks is not installed. Please install it:"
  echo "  Mac: brew install gitleaks"
  echo "  Linux: sudo apt-get install gitleaks"
  exit 1
elif [ ! -x "$GITLEAKS_PATH" ]; then
  echo "Error: gitleaks exists but is not executable. Try:"
  echo "  chmod +x $GITLEAKS_PATH"
  exit 1
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

echo "${YELLOW}Running gitleaks to check for secrets...${NC}"
echo "Using: $GITLEAKS_PATH"

# Get all staged files
STAGED_FILES=$(git diff --cached --name-only)

if [ -z "$STAGED_FILES" ]; then
  echo "${GREEN}No staged files to scan${NC}"
  exit 0
fi

# Create a temporary directory to store staged files
TEMP_DIR=$(mktemp -d)
LEAK_FOUND=0

# Use git to write the staged version of each file to the temp directory
echo "Copying staged files to temporary directory for scanning..."
for FILE in $STAGED_FILES; do
  # Create the directory structure if needed
  FILE_DIR=$(dirname "$TEMP_DIR/$FILE")
  mkdir -p "$FILE_DIR"
  # Write the staged file content to the temp directory
  git show :"$FILE" > "$TEMP_DIR/$FILE" 2>/dev/null || true
done

# Scan the temporary directory with the --no-git flag
echo "Scanning staged files..."
if "$GITLEAKS_PATH" detect --verbose --redact --no-git -s "$TEMP_DIR" 2>/dev/null; then
  echo "${GREEN}No secrets detected in staged files!${NC}"
  # Clean up
  rm -rf "$TEMP_DIR"
  exit 0
else
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 1 ]; then
    # gitleaks found secrets
    echo "${RED}ERROR: Potential secrets detected in your staged files!${NC}"
    echo "${RED}Commit aborted. Please remove the secrets before trying again.${NC}"
    echo "${YELLOW}If this is a false positive, you can bypass this check with:${NC}"
    echo "${YELLOW}  git commit --no-verify${NC}"
    # Clean up
    rm -rf "$TEMP_DIR"
    exit 1
  else
    # Other error
    echo "${RED}ERROR: gitleaks failed with exit code $EXIT_CODE${NC}"
    echo "${YELLOW}Debugging info:${NC}"
    echo "gitleaks path: $GITLEAKS_PATH"
    echo "Try running manually: $GITLEAKS_PATH detect --verbose --redact --no-git -s ."
    echo "Or bypass with: git commit --no-verify -m \"your message\""
    # Clean up
    rm -rf "$TEMP_DIR"
    exit $EXIT_CODE
  fi
fi

# Ensure cleanup
rm -rf "$TEMP_DIR"

exit 0 
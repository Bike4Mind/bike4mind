#!/bin/bash

# Script to install Bike4Mind's gitleaks integration with Husky hooks

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "${BLUE}=== Installing gitleaks for Bike4Mind ===${NC}"

# Check OS for better error handling
SYSTEM_TYPE=$(uname -s)
echo "Detected system: ${SYSTEM_TYPE}"

# Get the full path to gitleaks
GITLEAKS_PATH=$(which gitleaks 2>/dev/null)
if [ -z "$GITLEAKS_PATH" ]; then
    echo "${YELLOW}gitleaks not found in PATH.${NC}"
    
    if [ "$SYSTEM_TYPE" = "Darwin" ]; then
        # macOS installation
        echo "Installing gitleaks via Homebrew..."
        if ! command -v brew &> /dev/null; then
            echo "${RED}Homebrew not found. Please install Homebrew first:${NC}"
            echo "  /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
            exit 1
        fi
        
        brew install gitleaks
        if [ $? -ne 0 ]; then
            echo "${RED}Failed to install gitleaks via Homebrew.${NC}"
            exit 1
        fi
    elif [ "$SYSTEM_TYPE" = "Linux" ]; then
        # Linux installation
        echo "For Linux, please install gitleaks with one of these methods:"
        echo "1. Package manager (if available): sudo apt-get install gitleaks"
        echo "2. Download binary from GitHub: https://github.com/gitleaks/gitleaks/releases"
        echo "3. Using Go: go install github.com/gitleaks/gitleaks@latest"
        echo ""
        echo "After installing, run this script again."
        exit 1
    else
        echo "${RED}Unsupported operating system: ${SYSTEM_TYPE}${NC}"
        echo "Please install gitleaks manually from https://github.com/gitleaks/gitleaks/releases"
        exit 1
    fi
    
    # Check if installation worked
    GITLEAKS_PATH=$(which gitleaks 2>/dev/null)
    if [ -z "$GITLEAKS_PATH" ]; then
        echo "${RED}gitleaks installation failed or not in PATH.${NC}"
        exit 1
    fi
else
    echo "${GREEN}Found gitleaks at: ${GITLEAKS_PATH}${NC}"
    # Check if executable
    if [ ! -x "$GITLEAKS_PATH" ]; then
        echo "${YELLOW}gitleaks exists but is not executable. Fixing permissions...${NC}"
        chmod +x "$GITLEAKS_PATH"
        if [ $? -ne 0 ]; then
            echo "${RED}Failed to set executable permissions. Try running:${NC}"
            echo "  sudo chmod +x $GITLEAKS_PATH"
            exit 1
        fi
        echo "${GREEN}Fixed executable permissions.${NC}"
    fi
fi

# Check if gitleaks works
echo "${YELLOW}Testing gitleaks...${NC}"
GITLEAKS_VERSION=$("$GITLEAKS_PATH" version 2>&1)
if [ $? -ne 0 ]; then
    echo "${RED}Failed to run gitleaks. Error output:${NC}"
    echo "$GITLEAKS_VERSION"
    
    if [[ "$GITLEAKS_VERSION" == *"dyld"* ]] && [ "$SYSTEM_TYPE" = "Darwin" ]; then
        echo "${YELLOW}macOS dynamic library issue detected. Trying to reinstall...${NC}"
        brew reinstall gitleaks
        if [ $? -ne 0 ]; then
            echo "${RED}Reinstall failed.${NC}"
            exit 1
        fi
    else
        echo "${RED}Please reinstall gitleaks manually.${NC}"
        exit 1
    fi
    
    # Check again
    GITLEAKS_VERSION=$("$GITLEAKS_PATH" version 2>&1)
    if [ $? -ne 0 ]; then
        echo "${RED}gitleaks still not working after reinstall.${NC}"
        exit 1
    fi
fi

echo "${GREEN}gitleaks version: $GITLEAKS_VERSION${NC}"

# Check if Husky is installed
if [ ! -d ".husky" ]; then
    echo "${RED}Husky directory not found. Make sure Husky is installed.${NC}"
    echo "Run: npm run prepare"
    exit 1
fi

# Create the gitleaks pre-commit hook
echo "${YELLOW}Creating gitleaks pre-commit hook...${NC}"
cp .husky/gitleaks-pre-commit.sh .husky/gitleaks-pre-commit.sh.bak 2>/dev/null || true
cat > .husky/gitleaks-pre-commit.sh << 'EOL'
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
EOL

# Make sure our pre-commit hook is executable
chmod +x .husky/gitleaks-pre-commit.sh

# Test the hook with the configured setup
echo "${YELLOW}Testing gitleaks manually to verify installation...${NC}"
echo "Running: $GITLEAKS_PATH --version"
"$GITLEAKS_PATH" --version

echo "Running gitleaks basic test command:"
echo "$GITLEAKS_PATH detect --verbose --redact --no-git -s ."
"$GITLEAKS_PATH" detect --verbose --redact --no-git -s . || true

echo ""
echo "${GREEN}gitleaks installed successfully as a Husky hook!${NC}"
echo "The pre-commit hook will now scan for secrets before each commit."
echo ""
echo "${YELLOW}Usage:${NC}"
echo "1. The hook will automatically run when you commit changes"
echo "2. If you need to bypass the hook for a specific commit:"
echo "   git commit --no-verify -m \"your message\""
echo ""
echo "${YELLOW}Testing:${NC}"
echo "To test the hook with a sample secret:"
echo "  echo 'private_key=\"-----BEGIN RSA PRIVATE KEY-----\"' > test-secret.txt"
echo "  git add test-secret.txt"
echo "  git commit -m 'test secret detection'"
echo ""
echo "${YELLOW}For a full scan of your codebase:${NC}"
echo "  ./review-secrets.sh" 
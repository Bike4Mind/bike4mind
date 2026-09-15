#!/bin/bash
# Script to diagnose and fix gitleaks installation issues

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "${BLUE}=== Bike4Mind Gitleaks Diagnostics Tool ===${NC}"
echo "This script will diagnose and attempt to fix issues with gitleaks."
echo ""

# Check OS
SYSTEM_TYPE=$(uname -s)
echo "Detected system: ${SYSTEM_TYPE}"

# Check if gitleaks is installed
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
        echo "For Linux, you can install gitleaks in several ways:"
        echo "1. Using package manager (if available): sudo apt-get install gitleaks"
        echo "2. Download binary from GitHub: https://github.com/gitleaks/gitleaks/releases"
        echo "3. Using Go: go install github.com/gitleaks/gitleaks@latest"
        
        read -p "Would you like to try installing via Go? (y/n) " INSTALL_GO
        if [[ "$INSTALL_GO" =~ ^[Yy]$ ]]; then
            if command -v go &> /dev/null; then
                go install github.com/gitleaks/gitleaks@latest
                if [ $? -ne 0 ]; then
                    echo "${RED}Failed to install gitleaks via Go.${NC}"
                    exit 1
                fi
                echo "${GREEN}Installed gitleaks via Go.${NC}"
                echo "Make sure your Go bin directory is in your PATH."
            else
                echo "${RED}Go not found. Please install Go first or use another installation method.${NC}"
                exit 1
            fi
        else
            echo "Please install gitleaks manually and run this script again."
            exit 1
        fi
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
    echo "${GREEN}gitleaks found at: ${GITLEAKS_PATH}${NC}"
fi

# Check executable permissions
if [ ! -x "$GITLEAKS_PATH" ]; then
    echo "${YELLOW}gitleaks exists but is not executable. Fixing permissions...${NC}"
    chmod +x "$GITLEAKS_PATH"
    if [ $? -ne 0 ]; then
        echo "${RED}Failed to set executable permissions. Try running:${NC}"
        echo "  sudo chmod +x $GITLEAKS_PATH"
        exit 1
    fi
    echo "${GREEN}Fixed executable permissions.${NC}"
else
    echo "${GREEN}gitleaks has correct executable permissions.${NC}"
fi

# Check if gitleaks works
echo "${YELLOW}Testing gitleaks...${NC}"
GITLEAKS_VERSION=$(gitleaks version 2>&1)
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
    elif [ "$SYSTEM_TYPE" = "Darwin" ]; then
        echo "${YELLOW}Attempting to reinstall gitleaks...${NC}"
        brew reinstall gitleaks
    else
        echo "${RED}Please reinstall gitleaks manually.${NC}"
        exit 1
    fi
    
    # Check again
    GITLEAKS_VERSION=$(gitleaks version 2>&1)
    if [ $? -ne 0 ]; then
        echo "${RED}gitleaks still not working after reinstall.${NC}"
        exit 1
    fi
fi

echo "${GREEN}gitleaks version: $GITLEAKS_VERSION${NC}"

# Test configuration files
echo "${YELLOW}Testing gitleaks configuration...${NC}"
if [ -f ".gitleaks.toml" ]; then
    echo "Testing main config file..."
    if gitleaks detect --no-git --path . --config-path .gitleaks.toml --no-banner 2>/dev/null; then
        echo "${GREEN}Main config file is valid!${NC}"
    else
        if [ $? -eq 2 ]; then
            echo "${RED}Main config file has syntax errors.${NC}"
            echo "Will try to use simple config or default config instead."
        elif [ $? -eq 1 ]; then
            echo "${YELLOW}Main config valid but found secrets. This is expected.${NC}"
        else
            echo "${RED}Unknown error with main config.${NC}"
        fi
    fi
else
    echo "${RED}Main config file .gitleaks.toml not found.${NC}"
fi

if [ -f ".gitleaks.toml.simple" ]; then
    echo "Testing simple config file..."
    if gitleaks detect --no-git --path . --config-path .gitleaks.toml.simple --no-banner 2>/dev/null; then
        echo "${GREEN}Simple config file is valid!${NC}"
    else
        if [ $? -eq 2 ]; then
            echo "${RED}Simple config file has syntax errors.${NC}"
            echo "Will try to use default config instead."
        elif [ $? -eq 1 ]; then
            echo "${YELLOW}Simple config valid but found secrets. This is expected.${NC}"
        else
            echo "${RED}Unknown error with simple config.${NC}"
        fi
    fi
else
    echo "${YELLOW}Simple config file .gitleaks.toml.simple not found.${NC}"
fi

echo "Testing default config..."
if gitleaks detect --no-git --path . --no-banner 2>/dev/null; then
    echo "${GREEN}Default config works!${NC}"
else
    if [ $? -eq 1 ]; then
        echo "${YELLOW}Default config valid but found secrets. This is expected.${NC}"
    else
        echo "${RED}Unknown error with default config.${NC}"
    fi
fi

# Run the installer
echo "${YELLOW}Running install-hooks.sh script...${NC}"
./install-hooks.sh

echo ""
echo "${GREEN}Diagnostics complete!${NC}"
echo "If you're still having issues, please:"
echo "1. Try a different gitleaks installation method"
echo "2. Check for any error messages in the output above"
echo "3. Report the issue with the full output of this script" 
#!/bin/bash

# Setup script for GitHub Actions AWS OIDC provider and IAM role
# This script helps set up the necessary AWS resources for GitHub Actions deployment
# Supports multi-account setup (dev and prod accounts)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${GREEN}GitHub Actions AWS Multi-Account Setup Script${NC}"
echo "================================================"

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo -e "${RED}Error: AWS CLI is not installed. Please install it first.${NC}"
    exit 1
fi

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo -e "${RED}Error: jq is not installed. Please install it first.${NC}"
    exit 1
fi

# Get GitHub repository details
echo -e "${YELLOW}Please enter your GitHub repository details:${NC}"
read -p "GitHub organization/username: " GITHUB_ORG
read -p "GitHub repository name: " GITHUB_REPO

# Function to setup account
setup_account() {
    local account_name=$1
    local profile_name=$2
    
    echo -e "${BLUE}Setting up $account_name account...${NC}"
    
    # Get AWS account ID
    echo -e "${YELLOW}Getting AWS account ID for $account_name...${NC}"
    echo -e "${BLUE}Command: aws sts get-caller-identity --profile $profile_name --query Account --output text${NC}"
    AWS_ACCOUNT_ID=$(aws sts get-caller-identity --profile "$profile_name" --query Account --output text)
    echo -e "${GREEN}AWS Account ID for $account_name: $AWS_ACCOUNT_ID${NC}"
    
    # Create OIDC provider
    echo -e "${YELLOW}Creating OIDC provider for $account_name...${NC}"
    echo -e "${BLUE}Command: aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 --tags Key=Name,Value=github-actions-oidc-provider --profile $profile_name${NC}"
    aws iam create-open-id-connect-provider \
        --url https://token.actions.githubusercontent.com \
        --client-id-list sts.amazonaws.com \
        --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 \
        --tags Key=Name,Value=github-actions-oidc-provider \
        --profile "$profile_name" 2>&1 || {
        echo -e "${YELLOW}OIDC provider already exists in $account_name, continuing...${NC}"
    }
    
    # Create trust policy
    echo -e "${YELLOW}Creating trust policy for $account_name...${NC}"
    echo -e "${BLUE}Generating trust policy JSON with placeholders...${NC}"
    TRUST_POLICY=$(cat <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:GITHUB_ORG/GITHUB_REPO:*"
        }
      }
    }
  ]
}
EOF
)
    
    # Replace placeholders with actual values
    echo -e "${BLUE}Replacing placeholders in trust policy...${NC}"
    echo -e "${BLUE}  ACCOUNT_ID -> ${AWS_ACCOUNT_ID}${NC}"
    echo -e "${BLUE}  GITHUB_ORG -> ${GITHUB_ORG}${NC}"
    echo -e "${BLUE}  GITHUB_REPO -> ${GITHUB_REPO}${NC}"
    TRUST_POLICY=$(echo "$TRUST_POLICY" | sed "s/ACCOUNT_ID/${AWS_ACCOUNT_ID}/g" | sed "s/GITHUB_ORG/${GITHUB_ORG}/g" | sed "s/GITHUB_REPO/${GITHUB_REPO}/g")
    
    # Validate JSON before writing to file
    echo -e "${BLUE}Validating trust policy JSON...${NC}"
    if ! echo "$TRUST_POLICY" | jq . > /dev/null 2>&1; then
        echo -e "${RED}Error: Invalid JSON in trust policy for $account_name${NC}"
        echo -e "${RED}Trust policy content:${NC}"
        echo "$TRUST_POLICY"
        exit 1
    fi
    echo -e "${GREEN}Trust policy JSON is valid${NC}"
    
    echo -e "${BLUE}Writing trust policy to /tmp/trust-policy-${account_name}.json${NC}"
    echo "$TRUST_POLICY" | jq -c . > "/tmp/trust-policy-${account_name}.json"
    
    # Debug: Show the final JSON that will be used
    echo -e "${BLUE}Final trust policy JSON that will be used:${NC}"
    echo "$TRUST_POLICY" | jq .
    
    # Create IAM role
    echo -e "${YELLOW}Creating IAM role for $account_name...${NC}"
    ROLE_NAME="GitHubActionsSSTDeploy${account_name}"
    echo -e "${BLUE}Role name: $ROLE_NAME${NC}"
    
    # Check if role already exists
    echo -e "${BLUE}Checking if role already exists...${NC}"
    echo -e "${BLUE}Command: aws iam get-role --role-name $ROLE_NAME --profile $profile_name${NC}"
    if aws iam get-role --role-name "$ROLE_NAME" --profile "$profile_name" >/dev/null 2>&1; then
        echo -e "${YELLOW}IAM role already exists in $account_name, continuing...${NC}"
    else
        echo -e "${BLUE}Role does not exist, creating it...${NC}"
        # Create the role
        echo -e "${BLUE}Command: aws iam create-role --role-name $ROLE_NAME --assume-role-policy-document (inline) --description 'Role for GitHub Actions SST deployments in $account_name account' --profile $profile_name${NC}"
        if aws iam create-role \
            --role-name "$ROLE_NAME" \
            --assume-role-policy-document "$TRUST_POLICY" \
            --description "Role for GitHub Actions SST deployments in $account_name account" \
            --profile "$profile_name"; then
            echo -e "${GREEN}IAM role created successfully for $account_name${NC}"
        else
            echo -e "${RED}Failed to create IAM role for $account_name${NC}"
            echo -e "${RED}Trust policy content:${NC}"
            echo "$TRUST_POLICY"
            exit 1
        fi
    fi
    
    # Create single consolidated SST v3 policy
    create_policy() {
        local account_name=$1
        local account_id=$2
        local profile=$3
        
        echo -e "${YELLOW}Creating SST v3 policy for ${account_name}...${NC}"
        
        # Single SST v3 policy
        local policy_name="GitHubActionsSSTv3Policy${account_name}"
        echo -e "${BLUE}Creating SST v3 policy: ${policy_name}${NC}"
        
        cat > /tmp/sstv3-policy-${account_name}.json << 'EOF'
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "ManageBootstrapStateBucket",
            "Effect": "Allow",
            "Action": [
                "s3:CreateBucket",
                "s3:PutBucketVersioning",
                "s3:PutBucketNotification",
                "s3:PutBucketPolicy",
                "s3:DeleteObject",
                "s3:GetObject",
                "s3:ListBucket",
                "s3:PutObject"
            ],
            "Resource": [
                "arn:aws:s3:::sst-state-*"
            ]
        },
        {
            "Sid": "ManageBootstrapAssetBucket",
            "Effect": "Allow",
            "Action": [
                "s3:CreateBucket",
                "s3:PutBucketVersioning",
                "s3:PutBucketNotification",
                "s3:PutBucketPolicy",
                "s3:DeleteObject",
                "s3:GetObject",
                "s3:ListBucket",
                "s3:PutObject"
            ],
            "Resource": [
                "arn:aws:s3:::sst-asset-*"
            ]
        },
        {
            "Sid": "ManageBootstrapECRRepo",
            "Effect": "Allow",
            "Action": [
                "ecr:CreateRepository",
                "ecr:DescribeRepositories"
            ],
            "Resource": [
                "arn:aws:ecr:*:ACCOUNT_ID:repository/sst-asset"
            ]
        },
        {
            "Sid": "ManageBootstrapSSMParameter",
            "Effect": "Allow",
            "Action": [
                "ssm:GetParameters",
                "ssm:PutParameter"
            ],
            "Resource": [
                "arn:aws:ssm:*:ACCOUNT_ID:parameter/sst/passphrase/*",
                "arn:aws:ssm:*:ACCOUNT_ID:parameter/sst/bootstrap"
            ]
        },
        {
            "Sid": "Deployments",
            "Effect": "Allow",
            "Action": [
                "*"
            ],
            "Resource": [
                "*"
            ]
        },
        {
            "Sid": "ManageSecrets",
            "Effect": "Allow",
            "Action": [
                "ssm:DeleteParameter",
                "ssm:GetParameter",
                "ssm:GetParameters",
                "ssm:GetParametersByPath",
                "ssm:PutParameter"
            ],
            "Resource": [
                "arn:aws:ssm:*:ACCOUNT_ID:parameter/sst/*"
            ]
        },
        {
            "Sid": "LiveLambdaSocketConnection",
            "Effect": "Allow",
            "Action": [
                "appsync:EventSubscribe",
                "appsync:EventPublish",
                "appsync:EventConnect"
            ],
            "Resource": [
                "*"
            ]
        }
    ]
}
EOF

        # Replace placeholders
        sed -i.bak "s/ACCOUNT_ID/${account_id}/g" /tmp/sstv3-policy-${account_name}.json
        
        # Create SST v3 policy
        if ! aws iam get-policy --policy-arn "arn:aws:iam::${account_id}:policy/${policy_name}" --profile "${profile}" >/dev/null 2>&1; then
            echo -e "${BLUE}Creating SST v3 policy...${NC}"
            aws iam create-policy \
                --policy-name "${policy_name}" \
                --policy-document "file:///tmp/sstv3-policy-${account_name}.json" \
                --description "SST v3 deployment permissions for GitHub Actions in ${account_name} account" \
                --profile "${profile}"
            
            if [ $? -eq 0 ]; then
                echo -e "${GREEN}✓ SST v3 policy created successfully${NC}"
            else
                echo -e "${RED}✗ Failed to create SST v3 policy${NC}"
                return 1
            fi
        else
            echo -e "${YELLOW}SST v3 policy already exists, updating with latest permissions...${NC}"
            
            # Create a new policy version with updated permissions
            aws iam create-policy-version \
                --policy-arn "arn:aws:iam::${account_id}:policy/${policy_name}" \
                --policy-document "file:///tmp/sstv3-policy-${account_name}.json" \
                --set-as-default \
                --profile "${profile}"
            
            if [ $? -eq 0 ]; then
                echo -e "${GREEN}✓ SST v3 policy updated successfully${NC}"
                
                # Delete old policy versions (keep only the latest version)
                echo -e "${BLUE}Cleaning up old policy versions...${NC}"
                VERSIONS=$(aws iam list-policy-versions \
                    --policy-arn "arn:aws:iam::${account_id}:policy/${policy_name}" \
                    --profile "${profile}" \
                    --query 'Versions[?IsDefaultVersion==`false`].VersionId' \
                    --output text)
                
                for version in $VERSIONS; do
                    echo -e "${BLUE}Deleting old policy version: $version${NC}"
                    aws iam delete-policy-version \
                        --policy-arn "arn:aws:iam::${account_id}:policy/${policy_name}" \
                        --version-id "$version" \
                        --profile "${profile}" 2>/dev/null || true
                done
            else
                echo -e "${RED}✗ Failed to update SST v3 policy${NC}"
                return 1
            fi
        fi
        
        # Attach policy to the role
        echo -e "${YELLOW}Attaching SST v3 policy to role...${NC}"
        local role_name="GitHubActionsSSTDeploy${account_name}"
        
        echo -e "${BLUE}Attaching SST v3 policy...${NC}"
        aws iam attach-role-policy \
            --role-name "${role_name}" \
            --policy-arn "arn:aws:iam::${account_id}:policy/${policy_name}" \
            --profile "${profile}"
        
        echo -e "${GREEN}✓ SST v3 policy created and attached successfully${NC}"
        
        # Clean up temporary files
        rm -f /tmp/sstv3-policy-${account_name}.json /tmp/sstv3-policy-${account_name}.json.bak
        
        return 0
    }

    # Call the create_policy function
    if create_policy "$account_name" "$AWS_ACCOUNT_ID" "$profile_name"; then
        echo -e "${GREEN}✓ SST v3 policy created and attached successfully for $account_name${NC}"
    else
        echo -e "${RED}✗ Failed to create SST v3 policy for $account_name${NC}"
        exit 1
    fi
    
    # Get role ARN
    echo -e "${YELLOW}Getting role ARN for $account_name...${NC}"
    echo -e "${BLUE}Command: aws iam get-role --role-name $ROLE_NAME --profile $profile_name --query Role.Arn --output text${NC}"
    ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --profile "$profile_name" --query Role.Arn --output text)
    if [ -z "$ROLE_ARN" ]; then
        echo -e "${RED}Error: Could not get role ARN for $account_name. Role may not exist.${NC}"
        echo -e "${YELLOW}Attempting to list roles to debug...${NC}"
        echo -e "${BLUE}Command: aws iam list-roles --profile $profile_name --query 'Roles[?contains(RoleName, \`GitHubActions\`)]' --output table${NC}"
        aws iam list-roles --profile "$profile_name" --query "Roles[?contains(RoleName, 'GitHubActions')]" --output table
        echo -e "${YELLOW}Attempting to list all roles to see what exists...${NC}"
        echo -e "${BLUE}Command: aws iam list-roles --profile $profile_name --query 'Roles[?contains(RoleName, \`SST\`)]' --output table${NC}"
        aws iam list-roles --profile "$profile_name" --query "Roles[?contains(RoleName, 'SST')]" --output table
        exit 1
    fi
    echo -e "${GREEN}Role ARN: $ROLE_ARN${NC}"
    
    # Clean up temporary files
    echo -e "${BLUE}Cleaning up temporary files...${NC}"
    rm -f "/tmp/trust-policy-${account_name}.json"
    
    echo -e "${GREEN}Setup completed for $account_name account!${NC}"
    echo -e "${GREEN}Role ARN: $ROLE_ARN${NC}"
    echo ""
    
    # Store the role ARN in a global variable instead of returning it
    if [ "$account_name" = "dev" ]; then
        DEV_ROLE_ARN_RESULT="$ROLE_ARN"
    elif [ "$account_name" = "prod" ]; then
        PROD_ROLE_ARN_RESULT="$ROLE_ARN"
    fi
}

# Setup dev account
echo -e "${BLUE}Setting up DEV account...${NC}"
read -p "AWS profile name for dev account (or press Enter for default): " DEV_PROFILE
DEV_PROFILE=${DEV_PROFILE:-default}

setup_account "dev" "$DEV_PROFILE"
DEV_ROLE_ARN="$DEV_ROLE_ARN_RESULT"

# Setup prod account
echo -e "${BLUE}Setting up PROD account...${NC}"
read -p "AWS profile name for prod account: " PROD_PROFILE
if [ -z "$PROD_PROFILE" ]; then
    echo -e "${RED}Error: Prod account profile is required.${NC}"
    exit 1
fi

setup_account "prod" "$PROD_PROFILE"
PROD_ROLE_ARN="$PROD_ROLE_ARN_RESULT"

echo -e "${GREEN}Multi-account setup completed successfully!${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Add the following secrets to your GitHub repository:"
echo "   Name: AWS_DEV_ROLE_ARN"
echo "   Value: $DEV_ROLE_ARN"
echo ""
echo "   Name: AWS_PROD_ROLE_ARN"
echo "   Value: $PROD_ROLE_ARN"
echo ""
echo "2. Add other required secrets:"
echo "   - HOSTED_ZONE: Your Route53 hosted zone ID"
echo "   - VPC_ID: Your AWS VPC ID"
echo "   - ECR_CACHE_REPO: Your ECR repository for Docker cache"
echo ""
echo -e "${GREEN}Dev Role ARN: $DEV_ROLE_ARN${NC}"
echo -e "${GREEN}Prod Role ARN: $PROD_ROLE_ARN${NC}"
echo ""
echo -e "${YELLOW}Important Note:${NC}"
echo "The script automatically updates existing policies with the latest permissions from the script."
echo "This ensures your policies always have the most current permissions needed for deployment."
echo ""
echo -e "${YELLOW}Policy Update Behavior:${NC}"
echo "- Existing policies are always updated to match the current script version"
echo "- Old policy versions are cleaned up to keep only the latest version"
echo "- No manual intervention required - just re-run the script to update policies" 
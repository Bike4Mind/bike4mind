---
title: GitHub Actions Setup
description: How to set up GitHub Actions for deployment as an alternative to Seed CI/CD
sidebar_position: 2
---

# GitHub Actions Deployment Setup

This document outlines how to set up GitHub Actions for deployment as an alternative to Seed CI/CD.

## Overview

GitHub Actions provides a unified deployment workflow that offers:
- Automated deployments on push to main branches
- Preview environments for pull requests
- Automatic cleanup of preview environments
- Type checking and build validation
- Docker image caching for faster builds
- **Multi-account AWS deployment** (dev account for staging/preview, prod account for production)
- **Unified deployment process** for all environments
- **Environment-specific configuration** with clear separation between stages

## Deployment Options

This project supports two deployment platforms:

### Seed CI/CD
- **Configuration**: `seed.yml` file
- **Use Case**: Existing customers already using Seed
- **Setup**: Minimal - just configure Seed environment variables
- **Pros**: Simple, managed service, built-in caching
- **Cons**: Vendor lock-in, limited customization, cost

### GitHub Actions
- **Configuration**: `.github/workflows/deploy.yml`
- **Use Case**: New customers, self-hosted CI/CD, customization needs
- **Setup**: Requires AWS IAM setup and GitHub configuration
- **Pros**: Free for public repos, full customization, no vendor lock-in
- **Cons**: More complex initial setup, requires AWS knowledge

## GitHub Actions Workflow

### `deploy.yml` - Unified Deployment Workflow
- **Triggers**: 
  - Push to `main` or `prod` branches
  - Pull requests to `main` branches
- **Purpose**: Handle all deployments (production and preview)
- **AWS Accounts**:
  - `main` → `dev` stage → **dev account** (staging.bike4mind.com)
  - `prod` → `prod` stage → **prod account** (bike4mind.com)
  - `PR` → `pr{PR_NUMBER}` stage → **dev account** (preview environment)
- **Features**:
  - Single workflow handles all deployment scenarios
  - Automatic preview environment creation for PRs
  - Automatic cleanup when PRs are closed
  - Environment-specific configuration variables
  - Clear separation between staging and production infrastructure

## Branching Strategy

The deployment workflow follows a clear branching strategy that maps branches to stages and environments:

### Branch-to-Stage Mapping

| Branch | Stage | AWS Account | Environment | Variables Used |
|--------|-------|-------------|-------------|----------------|
| `main` | `dev` | **dev** | Staging | `STAGING_*` or fallback to common |
| `prod` | `production` | **prod** | Production | `PROD_*` or fallback to common |
| `PR` | `pr{PR_NUMBER}` | **dev** | Preview | `STAGING_*` + preview domain |

### Deployment Behavior

#### Protected Branches (Auto-Deploy)
- **`main` branch**: 
  - Maps to `dev` stage in dev account
  - Uses staging infrastructure (VPC, hosted zone, ECR)
  - Deploys to staging environment
  - Uses `STAGING_*` variables or falls back to common variables

- **`prod` branch**: 
  - Maps to `production` stage in prod account
  - Uses production infrastructure (VPC, hosted zone, ECR)
  - Deploys to production environment
  - Uses `PROD_*` variables or falls back to common variables

#### Pull Requests (Preview Deployments)
- **Any PR to `main`**:
  - Creates unique stage: `pr{PR_NUMBER}`
  - Uses dev account infrastructure (staging VPC, hosted zone, ECR)
  - Domain: `pr{PR_NUMBER}.{PREVIEW_SERVER_DOMAIN}`
  - **Automatic cleanup** when PR is closed
  - Uses `STAGING_*` variables for infrastructure

#### Other Branches
- **No automatic deployment**
- Branches like `feature/new-feature`, `bugfix/issue-123`, etc. are not deployed
- Only protected branches and PRs trigger deployments

### Environment Isolation

This strategy provides clear environment separation:

- **Staging Environment**: `main` branches → dev account
- **Production Environment**: `prod` branch → prod account  
- **Preview Environments**: PRs → dev account (isolated from production)
- **Development Branches**: No deployment (prevents accidental deployments)

### Benefits

- **Clear Separation**: Staging and production are completely isolated
- **Safe Previews**: PR deployments use staging infrastructure, not production
- **Automatic Cleanup**: Preview environments are automatically removed
- **Flexible Configuration**: Environment-specific variables allow customization
- **Protected Production**: Only `prod` branch can deploy to production account

## Required Configuration

### GitHub Repository Variables
Configure these in Settings → Secrets and variables → Actions → Variables:

#### Domain Configuration
- `SERVER_DOMAIN`: Common domain (fallback for all environments)
- `STAGING_SERVER_DOMAIN`: Staging-specific domain (overrides `SERVER_DOMAIN`)
- `PROD_SERVER_DOMAIN`: Production-specific domain (overrides `SERVER_DOMAIN`)
- `PREVIEW_SERVER_DOMAIN`: Base domain for preview environments

> **Note:** If you're migrating an existing deployment to a new domain, see the [Custom Domain Migration Guide](../domain-migration) for step-by-step instructions.

#### Infrastructure Configuration
- `VPC_ID`: Common VPC ID (fallback for all environments)
- `STAGING_VPC_ID`: Staging-specific VPC ID (overrides `VPC_ID`)
- `PROD_VPC_ID`: Production-specific VPC ID (overrides `VPC_ID`)

- `HOSTED_ZONE`: Common hosted zone (fallback for all environments)
- `STAGING_HOSTED_ZONE`: Staging-specific hosted zone (overrides `HOSTED_ZONE`)
- `PROD_HOSTED_ZONE`: Production-specific hosted zone (overrides `HOSTED_ZONE`)

- `ECR_CACHE_REPO`: Common ECR repository (fallback for all environments)
- `STAGING_ECR_CACHE_REPO`: Staging-specific ECR repository (overrides `ECR_CACHE_REPO`)
- `PROD_ECR_CACHE_REPO`: Production-specific ECR repository (overrides `ECR_CACHE_REPO`)

### GitHub Secrets
Configure these in Settings → Secrets and variables → Actions → Secrets:

#### AWS Authentication (Multi-Account)
- `AWS_DEV_ROLE_ARN`: ARN of the IAM role in the **dev account** that GitHub Actions can assume
  - Used for staging and preview deployments
  - Must have permissions to deploy SST resources in dev account
- `AWS_PROD_ROLE_ARN`: ARN of the IAM role in the **prod account** that GitHub Actions can assume
  - Used for production deployments only
  - Must have permissions to deploy SST resources in prod account

#### Optional Secrets
- `APP_CERT_ARN`: ARN of external SSL certificate (if not using Route53)
- `SLACK_ERROR_REPORTING_WEBHOOK_URL`: Slack webhook for deployment notifications

## Environment Variables Passed to SST

The workflow passes the following environment variables to `pnpm sst deploy`:

- `CI`: Set to `'true'` for CI environments
- `SEED_APP_NAME`: Application name (set to `'bike4mind'`)
- `SEED_STAGE_NAME`: Stage name (e.g., `dev`, `production`, `pr123`)
- `SERVER_DOMAIN`: The resolved domain for this deployment
- `HOSTED_ZONE`: The resolved hosted zone for this deployment
- `VPC_ID`: The resolved VPC ID for this deployment
- `ECR_CACHE_REPO`: The resolved ECR repository for this deployment

## Variable Resolution Logic

The workflow uses GitHub Actions' built-in `||` operator for variable resolution:

```yaml
# Staging environment
server_domain: ${{ vars.STAGING_SERVER_DOMAIN || vars.SERVER_DOMAIN }}
vpc_id: ${{ vars.STAGING_VPC_ID || vars.VPC_ID }}
hosted_zone: ${{ vars.STAGING_HOSTED_ZONE || vars.HOSTED_ZONE }}
ecr_cache_repo: ${{ vars.STAGING_ECR_CACHE_REPO || vars.ECR_CACHE_REPO }}

# Production environment  
server_domain: ${{ vars.PROD_SERVER_DOMAIN || vars.SERVER_DOMAIN }}
vpc_id: ${{ vars.PROD_VPC_ID || vars.VPC_ID }}
hosted_zone: ${{ vars.PROD_HOSTED_ZONE || vars.HOSTED_ZONE }}
ecr_cache_repo: ${{ vars.PROD_ECR_CACHE_REPO || vars.ECR_CACHE_REPO }}
```

This provides flexible configuration:
1. **Environment-specific variables** (e.g., `STAGING_SERVER_DOMAIN`) take precedence
2. **Common variables** (e.g., `SERVER_DOMAIN`) provide defaults
3. **Preview environments** use staging infrastructure with preview domains

## Configuration Strategies

### Strategy 1: Common Configuration (Simplest)
Set only the common variables for environments that share the same infrastructure:

```yaml
SERVER_DOMAIN: bike4mind.com
VPC_ID: vpc-12345678
HOSTED_ZONE: bike4mind.com
ECR_CACHE_REPO: 123456789012.dkr.ecr.us-east-2.amazonaws.com/cache
```

### Strategy 2: Environment-Specific Overrides
Use common variables for shared settings and environment-specific variables for overrides:

```yaml
# Common settings
SERVER_DOMAIN: bike4mind.com
VPC_ID: vpc-12345678
HOSTED_ZONE: bike4mind.com
ECR_CACHE_REPO: 123456789012.dkr.ecr.us-east-2.amazonaws.com/cache

# Staging overrides
STAGING_SERVER_DOMAIN: staging.bike4mind.com
STAGING_VPC_ID: vpc-87654321

# Production overrides
PROD_SERVER_DOMAIN: bike4mind.com
PROD_VPC_ID: vpc-11223344
```

### Strategy 3: Fully Environment-Specific
Set all variables per environment for complete separation:

```yaml
# Staging
STAGING_SERVER_DOMAIN: staging.bike4mind.com
STAGING_VPC_ID: vpc-87654321
STAGING_HOSTED_ZONE: bike4mind.com
STAGING_ECR_CACHE_REPO: 123456789012.dkr.ecr.us-east-2.amazonaws.com/staging-cache

# Production
PROD_SERVER_DOMAIN: bike4mind.com
PROD_VPC_ID: vpc-11223344
PROD_HOSTED_ZONE: bike4mind.com
PROD_ECR_CACHE_REPO: 987654321098.dkr.ecr.us-east-2.amazonaws.com/prod-cache
```

## AWS IAM Role Setup (Multi-Account)

The setup script automatically creates all necessary AWS resources for GitHub Actions deployment in both dev and prod accounts.

### Automated Setup (Recommended)

Use the provided setup script for both AWS accounts:

```bash
./scripts/setup-github-actions.sh
```

This script will:
- **Automatically detect AWS Account IDs** from your profiles
- **Create OIDC providers** in both accounts for GitHub Actions authentication
- **Create IAM roles** with proper trust policies (account IDs automatically substituted)
- **Create and attach policies** with scoped SST deployment permissions (following principle of least privilege)
- **Output the role ARNs** for GitHub Secrets

The script handles all the account ID substitutions and policy details automatically. The created policies are scoped to only the permissions needed for SST deployments, following security best practices. For implementation details, see the well-commented script at `scripts/setup-github-actions.sh`.

### Manual Setup

If you prefer manual setup, you'll need to:

1. **Create OIDC providers** in both AWS accounts
2. **Create IAM roles** with trust policies that reference the OIDC providers
3. **Create and attach policies** with SST deployment permissions
4. **Get the role ARNs** for GitHub Secrets

The setup script provides a complete reference implementation for all these steps.

### Required Permissions

Both roles should have permissions for:
- CloudFormation (for SST deployments)
- ECR (for Docker image operations)
- Route53 (for DNS management)
- All AWS services that your SST app uses

The setup script creates scoped policies that follow the principle of least privilege, granting only the specific permissions needed for SST deployments rather than broad `"*"` permissions.

### Security Best Practices

The setup script implements several security best practices:

1. **Principle of Least Privilege**: Policies are scoped to specific resources and actions rather than using broad `"*"` permissions
2. **Resource Naming**: Permissions are limited to resources with specific naming patterns (e.g., `sst-*`, `*-dev-*`, `*-prod-*`)
3. **Account Isolation**: Each account has its own role with account-specific resource ARNs
4. **OIDC Authentication**: Uses GitHub's OIDC provider for secure, token-based authentication
5. **Repository Scoping**: Trust policies are scoped to specific GitHub repositories

This approach significantly reduces the attack surface compared to broad `"*"` permissions while still providing all necessary capabilities for SST deployments.

## Setup Steps

### 1. Automated Setup (Recommended)
Use the provided setup script for both AWS accounts:

```bash
./scripts/setup-github-actions.sh
```

This script will:
- **Automatically detect AWS Account IDs** from your profiles
- **Create OIDC providers** in both accounts for GitHub Actions authentication
- **Create IAM roles** with proper trust policies (account IDs automatically substituted)
- **Create and attach policies** with scoped SST deployment permissions (following principle of least privilege)
- **Output the role ARNs** for GitHub Secrets

The script handles all the account ID substitutions and policy details automatically. The created policies are scoped to only the permissions needed for SST deployments, following security best practices. For implementation details, see the well-commented script at `scripts/setup-github-actions.sh`.

### 2. Manual Setup
If you prefer manual setup, follow these steps:

#### Set up AWS OIDC Providers
Set up OIDC providers in **both** AWS accounts:

```bash
# For dev account
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 \
  --profile dev-account

# For prod account  
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 \
  --profile prod-account
```

#### Create IAM Roles
Create the IAM roles in both accounts with the trust policies below. **Replace the account IDs** with your actual AWS account IDs:

**Dev Account Trust Policy:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::YOUR_DEV_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:YOUR_ORG/YOUR_REPO:*"
        }
      }
    }
  ]
}
```

**Prod Account Trust Policy:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::YOUR_PROD_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:YOUR_ORG/YOUR_REPO:*"
        }
      }
    }
  ]
}
```

**To find your AWS Account IDs:**
```bash
# For dev account
aws sts get-caller-identity --profile dev-account --query Account --output text

# For prod account
aws sts get-caller-identity --profile prod-account --query Account --output text
```

#### Create IAM Roles
Create the IAM roles in both accounts with the trust policies above and attach necessary permissions.

### 3. Configure GitHub Repository Variables
1. Go to your repository settings
2. Navigate to Secrets and variables → Actions → Variables
3. Add the environment-specific variables listed above

### 4. Configure GitHub Secrets
1. Go to your repository settings
2. Navigate to Secrets and variables → Actions → Secrets
3. Add the AWS role ARNs and optional secrets listed above

### 5. Test the Workflows
1. Create a test branch and push changes
2. Verify the deployment workflow runs correctly
3. Create a test PR to verify preview deployments

## Platform Comparison

| Feature | Seed | GitHub Actions |
|---------|------|----------------|
| Build Environment | Seed-managed | GitHub-hosted runners |
| Docker Caching | ECR-based | ECR-based (same) |
| Preview Environments | Manual setup | Automatic PR-based |
| Cleanup | Manual | Automatic on PR close |
| Multi-Account Support | Limited | Full support |
| Unified Workflow | No | Single workflow for all deployments |
| Domain Configuration | Hardcoded | Repository variables |
| Infrastructure Config | Hardcoded | Repository variables |
| Environment Separation | Stage-specific env vars | Environment-specific variables |
| Cost | Seed pricing | Free for public repos |
| Customization | Limited | Full GitHub Actions features |
| Setup Complexity | Low | Medium (one-time) |
| Vendor Lock-in | Yes | No |

## Security Benefits

The multi-account setup provides several security benefits:
- **Isolation**: Dev and prod environments are completely separated
- **Least Privilege**: Each role only has access to its respective account
- **Audit Trail**: Clear separation of dev vs prod deployments
- **Risk Mitigation**: Accidental deployments to prod are prevented by account separation

## Benefits of GitHub Actions

- **Consistency**: Same deployment process for all environments
- **Maintainability**: Single workflow to maintain and debug
- **DRY Principle**: No code duplication between preview and production
- **Simplified Configuration**: Shared environment variables and steps
- **No Vendor Lock-in**: Full control over your CI/CD pipeline
- **Cost Effective**: Free for public repositories
- **Extensible**: Can add custom steps, notifications, and integrations

## DNS Configuration Notes

- `HOSTED_ZONE` should be the DNS name (e.g., `bike4mind.com`), not the hosted zone ID
- For preview environments, the hosted zone is typically `preview.bike4mind.com`
- For production environments, the hosted zone is typically `bike4mind.com`
- SST automatically determines the hosted zone based on the domain if not explicitly set

## Preview Domain Calculation

The SST configuration automatically calculates the preview domain using this logic:

```typescript
const previewDomain = process.env.PREVIEW_DOMAIN || `preview.${process.env.SERVER_DOMAIN || 'bike4mind.com'}`;
```

This means:
1. If `PREVIEW_DOMAIN` is explicitly set, use that
2. Otherwise, construct it as `preview.${SERVER_DOMAIN}`
3. If `SERVER_DOMAIN` is not set, fall back to `preview.bike4mind.com`

For GitHub Actions, we use `PREVIEW_SERVER_DOMAIN` to construct preview URLs like `pr123.preview.bike4mind.com`.

## Troubleshooting

### Common Issues

1. **AWS Authentication Errors**
   - Verify the IAM role ARNs are correct for each account
   - Check that OIDC providers are configured in both accounts
   - Ensure roles have necessary permissions in their respective accounts

2. **Cross-Account Issues**
   - Verify ECR repositories are accessible from the correct account
   - Check that Route53 hosted zones are in the correct account
   - Ensure VPC IDs match the account being deployed to

3. **Docker Build Failures**
   - Verify ECR repository exists and is accessible from the dev account
   - Check that the ECR cache repository is properly configured

4. **SST Deployment Failures**
   - Check that all required environment variables are set
   - Verify AWS region matches your infrastructure
   - Review SST logs for specific error messages

5. **Domain Configuration Issues**
   - Verify repository variables are set correctly
   - Check that domains are properly formatted
   - Ensure DNS is configured for the domains

6. **Environment Variable Mismatches**
   - Ensure you're using the correct environment-specific variables
   - Check that staging variables are used for staging/preview deployments
   - Check that production variables are used for production deployments

### Debugging

To debug workflow issues:
1. Check the Actions tab in GitHub for detailed logs
2. Use `sst deploy --stage <stage> --verbose` for more detailed SST output
3. Verify secrets and variables are correctly configured in repository settings
4. Check that the correct AWS account is being used for each deployment
5. Verify environment-specific variables are set for the correct environment

## Support

For issues with:
- **GitHub Actions**: Check GitHub Actions documentation
- **SST**: Refer to SST documentation and community
- **AWS**: Use AWS support or community forums
- **Multi-Account Setup**: Refer to AWS Organizations documentation 
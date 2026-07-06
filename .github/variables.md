# GitHub Repository Variables and Secrets

This file documents the repository variables and secrets that need to be configured for the deployment workflow.

## Repository Variables (Not Secrets)

These variables are visible in logs and should be configured in your repository settings under Settings → Secrets and variables → Actions → Variables.

## Variable Mapping System

The deployment workflow uses a flexible variable mapping system that supports both common and environment-specific configurations:

### Fallback Logic

For each variable, the system tries environment-specific variables first, then falls back to common variables:

1. **Environment-specific variables** (e.g., `STAGING_SERVER_DOMAIN`) take precedence
2. **Common variables** (e.g., `SERVER_DOMAIN`) provide defaults
3. **Preview environments** use staging infrastructure with preview domains

### Supported Variables

#### Application Configuration
- `SEED_APP_NAME`: Application name for SST (defaults to `'bike4mind'` if not set)

#### Function Configuration
- `FUNCTION_VPC`: VPC configuration for Lambda functions (defaults to empty string if not set)
- `USE_DOCUMENTDB_COMPATIBILITY`: Enable DocumentDB compatibility mode (defaults to 'false' if not set)

#### Domain Configuration
- `SERVER_DOMAIN`: Common domain (fallback for all environments)
- `STAGING_SERVER_DOMAIN`: Staging-specific domain (overrides `SERVER_DOMAIN`)
- `PROD_SERVER_DOMAIN`: Production-specific domain (overrides `SERVER_DOMAIN`)
- `PREVIEW_SERVER_DOMAIN`: Base domain for preview environments

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

- `CACHE_POLICY_ID`: Common cache policy ID (fallback for all environments)
- `STAGING_CACHE_POLICY_ID`: Staging-specific cache policy ID (overrides `CACHE_POLICY_ID`)
- `PROD_CACHE_POLICY_ID`: Production-specific cache policy ID (overrides `CACHE_POLICY_ID`)

## Required Secrets

These secrets are sensitive and should be configured in your repository settings under Settings → Secrets and variables → Actions → Secrets.

### AWS Role ARNs
- `AWS_DEV_ROLE_ARN`: ARN of the AWS role for development/staging deployments
- `AWS_PROD_ROLE_ARN`: ARN of the AWS role for production deployments

### Submodule Access
- `SUBMODULE_SSH_KEY`: SSH private key for accessing Git submodules (if using private submodules)

## How to Configure

### Variables Configuration
1. Go to your repository on GitHub
2. Navigate to Settings → Secrets and variables → Actions
3. Click on the "Variables" tab
4. Add variables based on your needs

### Secrets Configuration
1. Go to your repository on GitHub
2. Navigate to Settings → Secrets and variables → Actions
3. Click on the "Secrets" tab
4. Add the required secrets

### Configuration Strategies

#### Strategy 1: Common Configuration (Simplest)
Set only the common variables for environments that share the same infrastructure:

```yaml
# Variables
SEED_APP_NAME: bike4mind
FUNCTION_VPC: vpc-12345678
SERVER_DOMAIN: bike4mind.com
VPC_ID: vpc-12345678
HOSTED_ZONE: bike4mind.com
ECR_CACHE_REPO: 123456789012.dkr.ecr.us-east-2.amazonaws.com/cache

# Secrets
AWS_DEV_ROLE_ARN: arn:aws:iam::123456789012:role/GitHubActionsDevRole
AWS_PROD_ROLE_ARN: arn:aws:iam::987654321098:role/GitHubActionsProdRole
```

#### Strategy 2: Environment-Specific Overrides
Use common variables for shared settings and environment-specific variables for overrides:

```yaml
# Common settings
SEED_APP_NAME: bike4mind
FUNCTION_VPC: vpc-12345678
USE_DOCUMENTDB_COMPATIBILITY: false
SERVER_DOMAIN: bike4mind.com
VPC_ID: vpc-12345678
HOSTED_ZONE: bike4mind.com
ECR_CACHE_REPO: 123456789012.dkr.ecr.us-east-2.amazonaws.com/cache
CACHE_POLICY_ID: 12345678-1234-1234-1234-123456789012

# Staging overrides
STAGING_SERVER_DOMAIN: staging.bike4mind.com
STAGING_VPC_ID: vpc-87654321
STAGING_CACHE_POLICY_ID: 87654321-4321-4321-4321-876543210987

# Production overrides
PROD_SERVER_DOMAIN: bike4mind.com
PROD_VPC_ID: vpc-11223344
PROD_CACHE_POLICY_ID: 11223344-1122-1122-1122-112233445566
```

#### Strategy 3: Fully Environment-Specific
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

## Example Configuration

| Variable Name | Example Value | Description |
|---------------|---------------|-------------|
| `SEED_APP_NAME` | `bike4mind` | Application name for SST |
| `FUNCTION_VPC` | `vpc-12345678` | VPC for Lambda functions (optional) |
| `USE_DOCUMENTDB_COMPATIBILITY` | `false` | Enable DocumentDB compatibility mode |
| `SERVER_DOMAIN` | `bike4mind.com` | Common domain (fallback) |
| `STAGING_SERVER_DOMAIN` | `staging.bike4mind.com` | Staging-specific domain |
| `PROD_SERVER_DOMAIN` | `bike4mind.com` | Production-specific domain |
| `PREVIEW_SERVER_DOMAIN` | `preview.bike4mind.com` | Preview environment base domain |
| `VPC_ID` | `vpc-12345678` | Common VPC ID (fallback) |
| `STAGING_VPC_ID` | `vpc-87654321` | Staging-specific VPC ID |
| `PROD_VPC_ID` | `vpc-11223344` | Production-specific VPC ID |
| `HOSTED_ZONE` | `bike4mind.com` | Common hosted zone (fallback) |
| `STAGING_HOSTED_ZONE` | `bike4mind.com` | Staging-specific hosted zone |
| `PROD_HOSTED_ZONE` | `bike4mind.com` | Production-specific hosted zone |
| `ECR_CACHE_REPO` | `123456789012.dkr.ecr.us-east-2.amazonaws.com/cache` | Common ECR repo (fallback) |
| `STAGING_ECR_CACHE_REPO` | `123456789012.dkr.ecr.us-east-2.amazonaws.com/staging-cache` | Staging-specific ECR repo |
| `PROD_ECR_CACHE_REPO` | `987654321098.dkr.ecr.us-east-2.amazonaws.com/prod-cache` | Production-specific ECR repo |
| `CACHE_POLICY_ID` | `12345678-1234-1234-1234-123456789012` | Common cache policy ID (fallback) |
| `STAGING_CACHE_POLICY_ID` | `87654321-4321-4321-4321-876543210987` | Staging-specific cache policy ID |
| `PROD_CACHE_POLICY_ID` | `11223344-1122-1122-1122-112233445566` | Production-specific cache policy ID |

| Secret Name | Example Value | Description |
|-------------|---------------|-------------|
| `AWS_DEV_ROLE_ARN` | `arn:aws:iam::123456789012:role/GitHubActionsDevRole` | AWS role for dev/staging deployments |
| `AWS_PROD_ROLE_ARN` | `arn:aws:iam::987654321098:role/GitHubActionsProdRole` | AWS role for production deployments |
| `SUBMODULE_SSH_KEY` | `-----BEGIN OPENSSH PRIVATE KEY-----...` | SSH key for submodule access (if needed) |

## Usage in Workflows

The workflow automatically maps variables based on the deployment environment:

- **Staging deployments**: Use `STAGING_*` variables or fall back to common variables
- **Production deployments**: Use `PROD_*` variables or fall back to common variables
- **Preview deployments**: Use staging infrastructure with preview domains

## Environment Variables Passed to SST

The workflow passes the following environment variables to `pnpm sst deploy`:

- `CI`: Set to `'true'` for CI environments
- `SEED_APP_NAME`: Application name (configurable, defaults to `'bike4mind'`)
- `SEED_STAGE_NAME`: Stage name (e.g., `staging`, `prod`, `pr123`)
- `SERVER_DOMAIN`: The resolved domain for this deployment
- `HOSTED_ZONE`: The resolved hosted zone for this deployment
- `VPC_ID`: The resolved VPC ID for this deployment
- `ECR_CACHE_REPO`: The resolved ECR repository for this deployment
- `FUNCTION_VPC`: VPC configuration for Lambda functions (optional)
- `CACHE_POLICY_ID`: The resolved cache policy ID for this deployment
- `USE_DOCUMENTDB_COMPATIBILITY`: DocumentDB compatibility mode setting

## Variable Resolution Logic

The workflow resolves variables using this logic:

```bash
# For each variable type (SERVER_DOMAIN, VPC_ID, HOSTED_ZONE, ECR_CACHE_REPO):

# Staging environment
if [ -n "$STAGING_VARIABLE" ]; then
  RESOLVED_VARIABLE="$STAGING_VARIABLE"
else
  RESOLVED_VARIABLE="$COMMON_VARIABLE"
fi

# Production environment
if [ -n "$PROD_VARIABLE" ]; then
  RESOLVED_VARIABLE="$PROD_VARIABLE"
else
  RESOLVED_VARIABLE="$COMMON_VARIABLE"
fi

# Preview environment
RESOLVED_VARIABLE="$STAGING_VARIABLE"  # Uses staging infrastructure
```

## Benefits of This Approach

1. **Flexibility**: Support for common, environment-specific, or mixed configurations
2. **Backward Compatibility**: Works with existing Seed-style configurations
3. **Gradual Migration**: Can start with common variables and add environment-specific ones later
4. **Clear Precedence**: Environment-specific variables always override common ones
5. **Debugging**: Clear logging shows which variables are being used
6. **Maintainability**: Easy to understand and modify configurations

## Preview Environment Configuration

Preview environments (PR deployments) use staging infrastructure:
- **VPC**: Uses resolved staging VPC ID
- **Hosted Zone**: Uses resolved staging hosted zone
- **ECR Cache**: Uses resolved staging ECR repository
- **Domain**: Constructed as `pr{PR_NUMBER}.{PREVIEW_SERVER_DOMAIN}`

This ensures preview environments are isolated from production but share staging infrastructure for cost efficiency.

### Opt-in gating (`preview_label`)

Preview deploys are **opt-in**. Each tenant in the `DEPLOY_TENANTS` repo variable carries a `preview_label` field, read by the `plan` job in `deploy.yml`:

- `preview_label: "preview"` (current) — a PR deploys a preview **only** when it carries the `preview` label. No label ⇒ the deploy matrix is empty ⇒ CI runs but no preview is deployed (the required **Deploy** check still reports green).
- `preview_label: null` — legacy "always deploy a preview on every trusted PR" behavior.

`deploy.yml` also triggers on the `labeled` pull_request event, so adding the label deploys immediately rather than waiting for the next push. Maintainers can toggle the label from a PR comment via the `/deploy preview` (opt-in) and `/deploy-preview off` (opt-out + teardown) commands — see `.github/workflows/deploy-preview-command.yml`. Removing the label tears the preview down (`cleanup.yml`, `unlabeled` trigger). Fork PRs never deploy previews regardless of labels.

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

## Migration from Seed

If migrating from Seed with stage-specific environment variables, you can:

1. **Keep existing variables**: Set common variables to match your current configuration
2. **Add environment-specific overrides**: Add `STAGING_*` and `PROD_*` variables for differences
3. **Gradually migrate**: Start with common variables and add environment-specific ones as needed

## Troubleshooting

### Common Issues

1. **Missing AWS Role ARNs**: Ensure both `AWS_DEV_ROLE_ARN` and `AWS_PROD_ROLE_ARN` are configured
2. **Submodule Access**: If using private submodules, ensure `SUBMODULE_SSH_KEY` is configured
3. **Variable Resolution**: Check workflow logs to see which variables are being resolved
4. **Environment Variables**: Verify that all required environment variables are being passed to SST commands

### Debugging

The workflow includes diagnostic output that shows:
- Which environment is being deployed
- What variables are being resolved
- What values are being used for each configuration

This information is logged using `tee` commands for visibility in the GitHub Actions logs. 
---
title: Seed CI/CD Setup
description: Configure Seed CI/CD for B4M deployment
sidebar_position: 3
---

# Seed CI/CD Setup

This guide covers setting up [Seed](https://seed.run) for B4M deployments.

## Prerequisites

- Seed account
- GitHub repository access
- AWS account with appropriate permissions

## Create Seed App

1. Log in to [Seed Dashboard](https://console.seed.run)
2. Click **Add an App**
3. **Link GitHub**:
   - Select your organization
   - Choose your fork repository (and b4m-core if separate)
4. **Configure Service**:
   - Path: `/`
   - Type: SST
   - Service name: `bike4mind`
5. Click **Add Service**

## Configure AWS IAM

1. In Seed, click **"Help me create an IAM role"**
2. For both dev and prod environments:
   - Click **Create an IAM Role using CloudFormation**
   - Select the correct AWS region
   - Check the Acknowledgment under Capabilities
   - Click **Create Stack**
3. Wait for CloudFormation to complete

## Environment Variables

Navigate to each environment (dev, prod) and set:

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `SERVER_DOMAIN` | Your domain | `yourdomain.com` |
| `PREVIEW_DOMAIN` | Preview builds domain | `preview.yourdomain.com` |
| `HOSTED_ZONE` | Route53 hosted zone | `yourdomain.com` |
| `VPC_ID` | Your VPC ID | `vpc-1234abcd` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `APP_CERT_ARN` | Custom SSL certificate ARN | Auto-generated |
| `FAB_FILES_BUCKET_NAME` | Knowledge files bucket | Auto-created |
| `GENERATED_IMAGES_BUCKET_NAME` | AI images bucket | Auto-created |
| `APP_FILES_BUCKET_NAME` | App files bucket | Auto-created |
| `ENABLE_BUCKET_VERSIONING` | Enable S3 versioning | `false` |
| `ENABLE_WARMING` | Lambda warming | `false` |
| `ECR_CACHE_REPO` | ECR repository for Docker cache | Required |

### Auto-Set by Seed

These are automatically configured:
- `SEED_APP_NAME`
- `SEED_STAGE_NAME`
- `CI=true`

## Configure Secrets

In Seed, go to **Settings > Secrets** for each stage and add:

```
MONGODB_URI=mongodb+srv://...
SESSION_SECRET=<generated>
JWT_SECRET=<generated>
MAIL_HOST=...
MAIL_PORT=...
MAIL_USERNAME=...
MAIL_PASSWORD=...
MAIL_FROM=...
```

See [Secrets Reference](../secrets-reference.md) for the complete list.

## Deployment Workflow

| Action | Trigger |
|--------|---------|
| Push to `main` | Deploys to dev stage |
| Push to `prod` | Deploys to production stage |
| PR created | Creates preview environment |
| PR merged | Removes preview environment |

## Monitoring

Seed provides:
- Deployment logs
- Build history
- Environment variables management
- Rollback capability

Access via the Seed dashboard at [console.seed.run](https://console.seed.run).

## Troubleshooting

### Build Fails with Route53 Error

**Cause:** Route53 hosted zone not accessible or misconfigured

**Fix:**
1. Verify `HOSTED_ZONE` environment variable matches your Route53 zone domain name exactly
2. Verify the hosted zone exists in the target AWS account
3. Verify IAM role has `route53:ListHostedZonesByName` permission

### IAM Permission Errors

**Cause:** IAM role missing permissions

**Fix:** Recreate the IAM role via CloudFormation with correct capabilities

### Lambda Deployment Timeout

**Cause:** Large bundle or slow network

**Fix:** Increase Seed timeout settings or optimize bundle size

## Next Steps

After Seed setup:
1. **[Configure domain](../domain-migration.md)** - Custom domain and OAuth
2. **[Set up email](../email/)** - Platform email configuration
3. **Verify deployment** - Test all functionality

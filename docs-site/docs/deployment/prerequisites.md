---
title: Prerequisites
description: AWS account setup, VPC, Route53, and database configuration for B4M deployment
sidebar_position: 2
content_type: ["procedural"]
audience: ["administrators", "devops"]
feature_status: stable
visibility: public
maturity: approved
tags:
  - deployment
  - aws
  - prerequisites
last_reviewed: 2026-01-13
---

# Prerequisites

Before deploying B4M, complete these AWS infrastructure prerequisites.

:::info For Fork Customers
If you're deploying B4M to your own AWS account, make sure your `AWS_PROFILE` and environment are configured correctly before running commands.
:::

## Local Tooling Prerequisites

Before running deployment commands (`pnpm sst`), ensure these tools are installed:

| Tool | Verification | Installation |
|------|--------------|--------------|
| Node.js 20.x | `node -v` | [nodejs.org](https://nodejs.org/) or `nvm install 20` |
| pnpm | `pnpm -v` | `npm install -g pnpm` |
| AWS CLI v2 | `aws --version` | `brew install awscli` (macOS) or [AWS docs](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) |

### AWS CLI Configuration

Configure AWS profiles in `~/.aws/config` to match your deployment accounts:

:::warning Replace Placeholder Values
The values below are examples. Replace with your actual AWS account IDs and SSO URLs.
:::

```ini
[sso-session your-org]
sso_start_url = https://your-org.awsapps.com/start
sso_region = us-east-1

[profile your-dev-profile]
sso_session = your-org
sso_account_id = 123456789012
sso_role_name = AdministratorAccess
region = us-east-1
```

Then authenticate:

```bash
aws sso login --profile your-dev-profile
```

## AWS Account Setup

### Create AWS Account

1. Follow [SST's AWS setup guide](https://v2.sst.dev/setting-up-aws) (skip the "Configure SST" section)
2. Create organization sub-accounts for dev and prod environments (recommended)
3. Log in under the proper sub-account for resource creation

### Enable Required Services

Navigate to each service in AWS Console and ensure they're enabled:

- **Bedrock**: Enable relevant models in **us-east-1** (not your local region)
  - Go to Bedrock Console → Model access → Enable Anthropic Claude models

### Configure Service Quotas

| Quota | Minimum Value | How to Check |
|-------|---------------|--------------|
| Lambda Concurrent Executions | 1000 (default) | Service Quotas → Lambda |
| AWS Roles Per Account | 3000 | Service Quotas → IAM (us-east-1 only) |

## Route53 Setup

### Create Hosted Zone

1. **Navigate to Route53** → Hosted zones → Create hosted zone
2. **Enter your domain** (e.g., `yourcompany.com`)
3. **Type**: Public hosted zone
4. **Click**: Create hosted zone

### Verify the Hosted Zone

After creation, your Hosted Zone ID is displayed (e.g., `Z0123456789ABCDEFGHIJ`) - AWS manages this internally.

:::tip HOSTED_ZONE uses domain names, not IDs
For GitHub variables, use the domain name (e.g., `HOSTED_ZONE=yourdomain.com`), not the zone ID.
SST automatically resolves the Route53 zone ID during deployment.
:::

### Update Domain Nameservers

:::warning DNS Propagation
Nameserver changes can take **24-48 hours** to fully propagate. Do this step first.
:::

1. **In Route53**, view the NS (Name Server) record for your zone
2. **Copy all 4 nameserver values** (e.g., `ns-123.awsdns-45.com`, `ns-456.awsdns-78.net`, etc.)
3. **Go to your domain registrar** (GoDaddy, Namecheap, Google Domains, etc.)
4. **Find DNS/Nameserver settings** for your domain
5. **Replace existing nameservers** with the 4 Route53 NS values

### Verify DNS Delegation

After waiting for propagation (usually 1-24 hours):

```bash
dig NS yourdomain.com +short
# Should return your 4 Route53 nameservers
```

## VPC Configuration

### Create VPC

1. **Navigate to VPC Console** → Your VPCs → Create VPC
2. **Select**: "VPC and more" (creates subnets, route tables, etc.)
3. **Configure**:
   - Name: `b4m-vpc` (or your preference)
   - IP range: Ensure no conflict with corporate networks
   - NAT gateway: 1 per AZ (minimum) or per corporate standards
4. **Note the VPC ID** (e.g., `vpc-1234abcd`)

:::note Using Default VPC
You cannot use the default public VPCs. B4M requires a VPC with NAT gateway for Lambda outbound access.
:::

## Database Setup

Choose one of these options:

### Option A: MongoDB Atlas (Recommended)

1. Create MongoDB Atlas account at [mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas)
2. Create a cluster (M10 or higher for production)
3. Configure network access (IP allowlist or VPC peering)
4. Get connection string: `mongodb+srv://...`

### Option B: AWS DocumentDB

1. **Navigate to DocumentDB Console** → Clusters → Create
2. **Configure**:
   - Cluster type: Instance-based
   - Size: Per organization needs
   - Password: Specify manually (don't use Secrets Manager)
3. **Note**: Set `MAIN_DB_TYPE=DocumentDB` in SST secrets

See [DocumentDB Setup](/databases/documentdb-setup) for detailed configuration.

## SES Setup (Optional)

If using platform email (one-time login codes, notifications):

### Verify Domain

1. **Navigate to SES Console** → Verified identities → Create identity
2. **Select**: Domain
3. **Enter**: Your domain (e.g., `yourcompany.com`)
4. **Add DNS records** as provided by SES (DKIM, verification)

### Request Production Access

New SES accounts are in sandbox mode. To send to any email address:

1. **SES Console** → Account dashboard → Request production access
2. **Provide use case description** (transactional emails for user notifications)
3. **Wait for approval** (typically 24-48 hours)

### Create SMTP Credentials

1. **SES Console** → SMTP settings → Create SMTP credentials
2. **Save** the username and password for `MAIL_USERNAME` and `MAIL_PASSWORD`

## ECR Repository

Create a repository for the subscriber-fanout Docker image:

1. **Navigate to ECR Console** → Repositories → Create repository
2. **Name**: `bike4mind/subscriber-fanout`
3. **Note the repository URI** for environment variables

## SST Bootstrap

After AWS account is configured:

```bash
pnpm sst bootstrap --profile your-aws-profile
```

This creates the necessary CloudFormation stacks for SST to manage your deployment.

## Next Steps

Once prerequisites are complete:

1. **[Configure Secrets](./secrets-reference.md)** - Set up SST secrets
2. **[Set Up CI/CD](./ci-cd/)** - GitHub Actions or Seed
3. **[Deploy](./domain-migration.md#phase-d-deployment)** - Initial deployment

# GitHub Actions Workflows

This directory contains automated workflows for the lumina5 repository. This document provides an overview of key workflows and their behavior in fork repositories.

## SST Secrets Management

The `set-sst-secrets.yml` workflow allows authorized team members to securely set SST secrets in AWS Parameter Store without requiring direct AWS credentials.

### Quick Start

```bash
# 1. Create a local secrets file (KEY=VALUE format)
cat > secrets.env <<'EOF'
GITHUB_MCP_CLIENT_ID=your-client-id
GITHUB_MCP_CLIENT_SECRET=your-secret
OPENAI_API_KEY=sk-your-key
ANTHROPIC_API_KEY=sk-ant-your-key
EOF

# 2. Run the workflow
gh workflow run set-sst-secrets.yml \
  --ref main \
  -f secrets_content="$(cat secrets.env)" \
  -f stage=dev \
  -f aws_account=dev

# 3. Monitor progress
gh run watch

# 4. Clean up
rm secrets.env
```

### Features

- ✅ **Team-based authorization** - Only DevOps team members can trigger
- ✅ **AWS OIDC authentication** - No long-term credentials needed
- ✅ **Secure secret handling** - Values never exposed in logs
- ✅ **Multi-secret support** - Upload entire secrets file at once
- ✅ **Format validation** - Keys must be UPPERCASE_WITH_UNDERSCORES
- ✅ **Repository safeguard** - Only runs in MillionOnMars/lumina5

### Full Documentation

For detailed setup instructions, security considerations, and troubleshooting, see:
- [`.github/SET_SST_SECRETS_INSTRUCTIONS.md`](../SET_SST_SECRETS_INSTRUCTIONS.md) - Complete guide
- [`.github/QUICK_START_SECRETS.md`](../QUICK_START_SECRETS.md) - Quick reference
- [`.github/secrets.template.env`](../secrets.template.env) - Format template

## What's New Modal Generation

The What's New modal system generates user-facing announcements from daily deployments. It uses a scheduled daily batching approach to prevent notification fatigue during hotfix cycles.

### Workflows

#### `generate-whats-new-modal-staging.yml`
- **Schedule**: Daily at 9am UTC (3am CST / 4am EST)
- **Environment**: Staging (dev)
- **Branch**: `main`
- **Purpose**: Batches all merged PRs from the last 24 hours into a single modal
- **Status**: ✅ Active

#### `generate-whats-new-modal-production.yml`
- **Schedule**: Daily at 10am UTC (2am PST / 5am EST)
- **Environment**: Production
- **Branch**: `prod`
- **Purpose**: Batches all merged PRs from the last 24 hours into a single modal
- **Status**: ⏸️ Temporarily Disabled (will be enabled after staging validation)

### Architecture

1. **Scheduled Daily Execution**: Workflows run on cron schedule instead of per-PR triggers
2. **PR Batching**: Queries GitHub Pull Requests API for all merged PRs to target branch from last 24 hours
3. **Smart Filtering**: Excludes noise (deps updates, typos, CI changes, docs-only) to focus on user-facing changes
4. **Early Exit**: If no user-facing PRs found in 24-hour window, workflow exits gracefully (no-op)
5. **Data Collection**: Gathers PR details, commits, and generates changelog context
6. **SQS Queue**: Sends batched payload to AWS SQS for Lambda processing
7. **Modal Generation**: Lambda handler generates user-friendly modal using AI with date-based titles

### Dependencies

- **GitHub Secrets** (required):
  - `WHATS_NEW_AWS_ACCESS_KEY_ID`: AWS IAM access key
  - `WHATS_NEW_AWS_SECRET_ACCESS_KEY`: AWS IAM secret key
  - `WHATS_NEW_QUEUE_URL`: SQS queue URL for modal generation

- **AWS Resources**:
  - SQS Queue: Receives modal generation requests
  - Lambda Function: Processes requests and generates modals
  - CloudWatch: Logs and metrics

For detailed operational documentation, see [`/docs/operations/whats-new-automation.md`](/docs/operations/whats-new-automation.md).

## Fork Behavior

### Why Workflows Don't Run in Forks

Many workflows in this repository include a repository check (`github.repository == 'MillionOnMars/lumina5'`) that prevents execution in fork repositories. This is intentional and serves several purposes:

1. **Prevents Duplicate Modals**: Forks shouldn't send modal notifications to production SQS queues
2. **Avoids AWS Costs**: Prevents unauthorized AWS API calls from fork repositories
3. **Security**: Protects production infrastructure from accidental or malicious use
4. **Separation of Concerns**: Forks can maintain their own deployment infrastructure

### Workflows with Fork Protection

The following workflows include repository checks and will not execute in forks:

- ✅ **What's New Modal Generation** (staging & production)
- ✅ **Security Scans** (`security-scan.yml`)
- ✅ **Package Publishing** (`release.yaml`, `snapshot-publish.yaml`)
- ✅ **Fork Sync Operations** (`fork-sync.yml`)

### For Fork Owners

If you maintain a fork of lumina5, these workflow files will be synced to your fork but **will not execute automatically**. This is by design.

#### To Enable Workflows in Your Fork

If you want to enable these workflows in your fork, you'll need to:

1. **Update Repository Check**: In each workflow file, find the line:
   ```yaml
   if: github.repository == 'MillionOnMars/lumina5'
   ```
   And change it to match your fork:
   ```yaml
   if: github.repository == 'YourUsername/lumina5'
   ```

2. **Configure AWS Resources**: Set up your own AWS infrastructure:
   - Create SQS queue for modal generation
   - Create Lambda function for processing
   - Create IAM user with appropriate permissions

3. **Add GitHub Secrets**: Configure the required secrets in your fork:
   - `Settings` → `Secrets and variables` → `Actions`
   - Add `WHATS_NEW_AWS_ACCESS_KEY_ID`
   - Add `WHATS_NEW_AWS_SECRET_ACCESS_KEY`
   - Add `WHATS_NEW_QUEUE_URL`

4. **Test Thoroughly**: Use the `workflow_dispatch` trigger to test manually before enabling scheduled runs

### Workflow Visibility

Even though workflows don't execute in forks, they remain visible in the Actions tab with a "skipped" status. This is normal GitHub Actions behavior.

## Troubleshooting

### Workflow Not Running in Main Repository

1. **Check Repository Protection**: Verify `github.repository` check is correct
2. **Verify Secrets**: Ensure all required GitHub Secrets are configured
3. **Check Cron Schedule**: Confirm workflow schedule is active (not commented out)
4. **Review Logs**: Check CloudWatch logs for Lambda errors

### Workflow Running When It Shouldn't

1. **Verify Repository Check**: Confirm the `if` condition is present and correct
2. **Check Branch**: Ensure you're on the expected branch
3. **Review Recent Commits**: Check if repository check was accidentally modified

## Additional Resources

- [What's New Automation Operations Guide](/docs/operations/whats-new-automation.md)
- [What's New Security Documentation](/docs/operations/whats-new-security.md)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Fork Sync Setup Guide](/docs/temp/FORK_SYNC_SETUP.md)

## Support

For questions or issues with workflows:
- Open an issue in the main repository
- Contact the platform team
- Review CloudWatch logs for detailed error messages

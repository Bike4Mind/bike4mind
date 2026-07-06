---
title: CI/CD Setup
description: Choose and configure your CI/CD pipeline for B4M deployment
sidebar_position: 1
---

# CI/CD Setup

B4M supports two CI/CD options for automated deployments.

## Comparison

| Feature | GitHub Actions | Seed |
|---------|---------------|------|
| **Recommended for** | New deployments | Existing Seed users |
| **Setup complexity** | Medium | Low |
| **Cost** | Free (public repos), included minutes (private) | Paid subscription |
| **Multi-account AWS** | Built-in support | Supported |
| **Preview environments** | PR-based previews | Supported |
| **Configuration** | YAML workflows | Web UI |

## Choose Your Path

### GitHub Actions (Recommended)

For most new deployments, GitHub Actions provides:
- Native GitHub integration
- Multi-account AWS deployment (dev/prod)
- Automatic PR preview environments
- No additional service costs

**[Set up GitHub Actions →](./github-actions.md)**

### Seed

If you're already using Seed or prefer a managed CI/CD service:
- Simpler initial setup
- Web-based configuration
- Built-in deployment monitoring

**[Set up Seed →](./seed.md)**

## Branching Strategy

Both options use this branching strategy:

| Branch | Stage | Environment |
|--------|-------|-------------|
| `prod` | production | Production |
| `main` | dev | Staging/Development |
| `pr-*` | preview | PR previews |

## Required GitHub Variables

Regardless of CI/CD choice, set these in your fork's repository settings:

```
SERVER_DOMAIN=yourdomain.com
PROD_SERVER_DOMAIN=yourdomain.com
STAGING_SERVER_DOMAIN=staging.yourdomain.com
PREVIEW_SERVER_DOMAIN=preview.yourdomain.com
HOSTED_ZONE=yourdomain.com
PROD_HOSTED_ZONE=yourdomain.com
```

## Next Steps

After CI/CD setup:
1. **[Configure Secrets](../secrets-reference.md)** - SST secrets
2. **[Deploy](../domain-migration.md#milestone-4-deploy-production)** - First deployment

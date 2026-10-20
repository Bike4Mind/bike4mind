---
title: Fork Setup Guide
description: Quick start guide for deploying your own fork with minimal configuration
sidebar_position: 2
content_type: ["guide"]
audience: ["administrators", "developers"]
feature_status: stable
visibility: public
maturity: approved
tags:
  - deployment
  - fork
  - secrets
  - configuration
last_reviewed: 2026-01-20
---

# Fork Setup Guide

This guide helps you deploy your own fork of B4M with minimal configuration. Not all secrets are required for basic operation.

## Required vs Optional Secrets

### Required Secrets (Deployment Will Fail Without These)

These secrets are essential for the application to start:

| Secret | Purpose | How to Generate |
|--------|---------|-----------------|
| `MONGODB_URI` | Database connection | Your MongoDB connection string |
| `SESSION_SECRET` | Session cookie signing | `openssl rand -base64 48` |
| `JWT_SECRET` | Authentication tokens | `openssl rand -base64 32` |
| `SECRET_ENCRYPTION_KEY` | Database secret encryption | `openssl rand -hex 32` |

### Optional Secrets (Features Disabled When Not Configured)

These secrets enable optional features. The application works without them, but the corresponding features will be disabled:

| Secret | Feature | Graceful Degradation |
|--------|---------|---------------------|
| `GOOGLE_CLIENT_ID` | Google OAuth login | Google login button won't appear |
| `GITHUB_CLIENT_ID` | GitHub OAuth login | GitHub login button won't appear |
| `NPM_TOKEN` | Private npm packages | Only public packages available |

## Quick Start: Minimal Fork Deployment

To deploy a minimal fork, you only need to set the 4 required secrets:

```bash
# Set required secrets
pnpm sst secret set MONGODB_URI "your-mongodb-connection-string" --stage production
pnpm sst secret set SESSION_SECRET "$(openssl rand -base64 48)" --stage production
pnpm sst secret set JWT_SECRET "$(openssl rand -base64 32)" --stage production
pnpm sst secret set SECRET_ENCRYPTION_KEY "$(openssl rand -hex 32)" --stage production
```

The optional secrets have placeholder defaults (`'not-configured'`) that allow deployment to proceed.

## Enabling Optional Features

### Google OAuth Login

1. Create OAuth credentials in [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Set the callback URL: `https://your-domain.com/api/auth/google/callback`
3. Configure secrets:
   ```bash
   pnpm sst secret set GOOGLE_CLIENT_ID "your-client-id" --stage production
   pnpm sst secret set GOOGLE_CLIENT_SECRET "your-client-secret" --stage production
   ```

### GitHub OAuth Login

1. Create OAuth App in [GitHub Developer Settings](https://github.com/settings/developers)
2. Set the callback URL: `https://your-domain.com/api/auth/github/callback`
3. Configure secrets:
   ```bash
   pnpm sst secret set GITHUB_CLIENT_ID "your-client-id" --stage production
   pnpm sst secret set GITHUB_CLIENT_SECRET "your-client-secret" --stage production
   ```

### Private NPM Packages

Only needed if your deployment uses private npm packages:

1. Generate an npm access token
2. Configure the secret:
   ```bash
   pnpm sst secret set NPM_TOKEN "your-npm-token" --stage production
   ```

## Checking Configuration Status

Use the System Health Dashboard to verify which features are properly configured:

1. Navigate to **Admin > System Health**
2. Check the OAuth and integrations sections
3. Features with `'not-configured'` placeholders will show as disabled

## Related Documentation

- [Secrets Reference](../deployment/secrets-reference.md) - Complete list of all secrets
- [Deployment Prerequisites](../deployment/prerequisites.md) - AWS and infrastructure setup

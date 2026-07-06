---
title: Identity Providers
description: Configure enterprise SSO via the Admin UI instead of SST secrets
sidebar_position: 15
content_type: ["conceptual", "how-to"]
audience: ["administrators"]
feature_status: stable
visibility: public
maturity: approved
tags:
  - authentication
  - sso
  - okta
  - enterprise
last_reviewed: 2026-01-15
---

# Identity Providers

Configure enterprise Single Sign-On (SSO) through the admin UI instead of managing SST secrets. This is the recommended approach for enterprise deployments.

## Overview

B4M supports two ways to configure Okta SSO:

| Method | Configuration Location | Best For |
|--------|----------------------|----------|
| **Database IDP** | Admin UI (Identity Providers) | Enterprise customers, multi-tenant setups |
| **SST Secrets** | Command line / CI/CD | Simple deployments, developer environments |

**Database IDP takes precedence over SST secrets.** If both are configured, the Database IDP configuration is used.

## When to Use Database IDP

Use the Identity Providers admin UI when:

- **Enterprise deployment** - Your organization manages SSO configuration through an admin interface
- **Non-technical admins** - Configuration changes shouldn't require CLI access
- **Multi-tenant** - Different email domains need different identity providers
- **Audit trail** - Changes are tracked in the application database

Use SST secrets when:

- **Simple setup** - Single Okta configuration for all users
- **Infrastructure as Code** - SSO config managed via CI/CD pipelines
- **No admin UI access** - Configuration during initial deployment

## Configuring Okta via Admin UI

### Step 1: Create Okta Application

In your Okta Admin Console:

1. Go to **Applications > Applications > Create App Integration**
2. Select **OIDC - OpenID Connect**
3. Select **Web Application**
4. Configure:
   - **App name**: Your application name
   - **Sign-in redirect URI**: `https://app.yourdomain.com/api/auth/okta/callback`
   - **Sign-out redirect URI**: `https://app.yourdomain.com`
5. Save and note the **Client ID** and **Client Secret**

### Step 2: Add Identity Provider in B4M

1. Go to **Admin > General Ops > Identity Providers**
2. Click **Add Identity Provider**
3. Fill in the form:

| Field | Description | Example |
|-------|-------------|---------|
| **Name** | Display name for this IDP | "Acme Corp Okta" |
| **Email Domain** | Users with this email domain use this IDP | "acme.com" |
| **Type** | Select "Okta" | Okta |
| **Active** | Enable/disable this IDP | On |
| **Audience (Okta Domain)** | Your Okta tenant URL | `https://acme.okta.com` |
| **Client ID** | From Okta app | `0oa...` |
| **Client Secret** | From Okta app | Click eye icon to verify |
| **Use Org-Level Authorization Server** | Check for org-level auth server | See below |

4. Click **Create**

### Authorization Server Types

Okta supports two authorization server types:

| Type | When to Use | Discovery URL |
|------|-------------|---------------|
| **Org-Level** | Free Okta plans, simple setups | `https://domain.okta.com/.well-known/openid-configuration` |
| **Custom** | Okta API Access Management license | `https://domain.okta.com/oauth2/default/.well-known/openid-configuration` |

Check **"Use Org-Level Authorization Server"** if:
- You're using a free Okta developer account
- You don't have Okta API Access Management license
- You see 404 errors with the default (custom) auth server

## How Login Works

When a user clicks **"Login with Okta"**:

1. B4M checks for an **active Database IDP** of type "okta"
2. If found, uses that configuration
3. If not found, falls back to **SST secrets** (`OKTA_AUDIENCE`, `OKTA_CLIENT_ID`, `OKTA_CLIENT_SECRET`)
4. If neither exists, shows an error

This means enterprise customers can configure Okta entirely through the admin UI without touching SST secrets (except for `JWT_SECRET` and `SECRET_ENCRYPTION_KEY` which are always required).

## Required SST Secrets

Even when using Database IDP, these SST secrets are **always required**:

| Secret | Purpose | Format |
|--------|---------|--------|
| `JWT_SECRET` | Signs OAuth state tokens (CSRF protection) | Min 32 characters |
| `SECRET_ENCRYPTION_KEY` | Encrypts OAuth tokens at rest (all providers, not just Okta) | Exactly 64 hex characters |

```bash
# Set required secrets
pnpm sst secret set JWT_SECRET "$(openssl rand -base64 32)" --stage <stage>
pnpm sst secret set SECRET_ENCRYPTION_KEY "$(openssl rand -hex 32)" --stage <stage>
```

:::warning These Secrets Cannot Be Configured via Admin UI
`JWT_SECRET` and `SECRET_ENCRYPTION_KEY` must be set via SST secrets. `SECRET_ENCRYPTION_KEY` encrypts secrets stored in the database, so storing it in the database would create a circular dependency.
:::

## Verifying Configuration

### System Health Dashboard

Go to **Admin > General Ops > System Health** to verify Okta configuration:

- **Configured** (green) - Ready to use
- **Missing** (red) - Configuration incomplete

The Okta card shows:
- **Config source** - "Database IDP" or "SST Secrets"
- **Missing secrets** - Any required secrets not configured
- **Warnings** - Non-blocking issues (e.g., JWT_SECRET too short)

### Test Okta Button

Click **"Test Okta"** to run comprehensive diagnostics:

| Check | What It Tests |
|-------|---------------|
| **Discovery** | Can reach Okta's `.well-known/openid-configuration` endpoint |
| **JWKS** | Signing keys are available for token validation |
| **Token Endpoint** | Token exchange endpoint responds correctly |
| **Userinfo Endpoint** | User info endpoint responds correctly |
| **Issuer** | Issuer URL matches expected value |
| **Signing** | RS256 signing algorithm is supported |

## Troubleshooting

### "okta_setup_failed" Error

**Cause:** Missing `JWT_SECRET`

**Fix:**
```bash
pnpm sst secret set JWT_SECRET "$(openssl rand -base64 32)" --stage <stage>
```

### "callback_error" After Okta Login

**Cause:** `SECRET_ENCRYPTION_KEY` is missing or has invalid format

**Fix:**
```bash
pnpm sst secret set SECRET_ENCRYPTION_KEY "$(openssl rand -hex 32)" --stage <stage>
```

### System Health Shows "Missing" But IDP Is Configured

**Cause:** `SECRET_ENCRYPTION_KEY` has invalid format (must be exactly 64 hex characters)

The System Health page validates the format, not just existence. Regenerate the key:
```bash
pnpm sst secret set SECRET_ENCRYPTION_KEY "$(openssl rand -hex 32)" --stage <stage>
```

### 404 Error on Okta Discovery

**Cause:** Wrong authorization server type selected

**Fix:** Toggle the **"Use Org-Level Authorization Server"** checkbox in the IDP configuration. Free Okta accounts typically need this checked.

### "Login with Okta" Uses Wrong Configuration

**Cause:** Both Database IDP and SST secrets are configured

Database IDP always takes precedence. To use SST secrets instead:
1. Go to **Admin > Identity Providers**
2. Either delete or deactivate the Okta IDP

## SAML Support

The Identity Providers feature also supports SAML 2.0. When adding a SAML provider:

1. Select **Type: SAML**
2. Configure:
   - **Entry Point (SSO URL)** - Your IdP's SAML SSO URL
   - **Issuer** - Your IdP's entity ID
   - **Certificate** - Your IdP's signing certificate (PEM format)

3. Use the **SP Metadata** button (info icon) to get values for your IdP:
   - **ACS URL**: `https://app.yourdomain.com/api/auth/saml/callback`
   - **Entity ID**: `https://app.yourdomain.com/saml/metadata`

## See Also

- **Secrets configuration** - `JWT_SECRET`, `SECRET_ENCRYPTION_KEY`, and OAuth credentials are managed as SST secrets (see the SST secrets section above)
- **Domain migration** - When changing your app domain, update the OAuth redirect/callback URLs registered with each identity provider to match the new hostname

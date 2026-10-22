---
title: Secrets Reference
description: Complete reference for all SST secrets required for B4M deployment
sidebar_position: 3
content_type: ["reference"]
audience: ["administrators", "devops"]
feature_status: stable
visibility: public
maturity: approved
tags:
  - deployment
  - secrets
  - configuration
last_reviewed: 2026-01-13
---

# Secrets Reference

:::info Prerequisites for Running Commands
Before running the commands on this page, ensure you have:
- **pnpm** installed: `npm install -g pnpm`
- **AWS CLI** configured with your deployment profile (see [Local Tooling Prerequisites](./prerequisites.md#local-tooling-prerequisites))
- **Dependencies installed**: Run `pnpm install` in the project root

If you encounter errors, see [Troubleshooting](./troubleshooting.md).
:::

This document covers all SST secrets required for B4M deployment, including how to detect which integrations are active.

## Setting Secrets

Set secrets using the SST CLI:

```bash
pnpm sst secret set <SECRET_NAME> <value> --stage <stage>
```

Or directly:

```bash
pnpm sst secret set <SECRET_NAME> <value> --stage <stage>
```

## What is "Platform Email"?

:::info Platform Email Explained
"Platform email" means the application sends emails **FROM** your domain (e.g., `notifications@yourcompany.com`). This includes:
- One-time login code emails (required for passwordless authentication)
- User invitation emails
- Session notifications
- AI agent communications

**If YES:** You need SES/SMTP setup with the `MAIL_*` secrets below
**If NO (OAuth SSO-only login):** You can skip email configuration, but users without an SSO provider will not be able to log in

Most deployments DO use platform email for user notifications.
:::

## Detecting Active Integrations

If you inherited a deployment or are unsure which integrations are active:

### Stripe (Billing/Subscriptions)

**How to check:**
1. Look for billing/subscription features in the app UI
2. Check SST secrets:
   ```bash
   pnpm sst secret list --stage production | grep STRIPE
   ```
3. If secrets contain actual values (not `"placeholder"`), Stripe is configured

**Impact if active:** Webhook URL must be updated when changing domains

### Atlassian (Jira/Confluence)

**How to check:**
1. In the app, go to **Admin → Settings**
2. Look for `atlassianClientId` and `atlassianClientSecret` values
3. Or check if users see "Connect to Atlassian" in their profile settings

**Impact if active:** OAuth callback URL must be updated in Atlassian Developer Console

### Google Drive

**How to check:**
1. Look for "Connect Google Drive" option in user settings
2. Uses same OAuth client as Google Login (`GOOGLE_CLIENT_ID`)

**Impact if active:** Add Drive callback URL: `https://app.yourdomain.com/google-drive/callback`

---

## Core Authentication Secrets (Required)

These secrets are **required** for the application to function:

| Secret | Description | Format | How to Generate |
|--------|-------------|--------|-----------------|
| `SESSION_SECRET` | Signs session cookies | Any string (48+ chars recommended) | `openssl rand -base64 48` |
| `JWT_SECRET` | OAuth state tokens, API auth | **Min 32 characters** | `openssl rand -base64 48` |
| `SECRET_ENCRYPTION_KEY` | Encrypts OAuth tokens at rest (AES-256) | **Exactly 64 hex characters** | `openssl rand -hex 32` |

```bash
# Generate and set all core secrets
pnpm sst secret set SESSION_SECRET "$(openssl rand -base64 48)" --stage <stage>
pnpm sst secret set JWT_SECRET "$(openssl rand -base64 48)" --stage <stage>
pnpm sst secret set SECRET_ENCRYPTION_KEY "$(openssl rand -hex 32)" --stage <stage>
```

### About SECRET_ENCRYPTION_KEY

`SECRET_ENCRYPTION_KEY` provides application-level encryption for sensitive data stored in the database. This is a defense-in-depth measure that complements MongoDB Atlas's at-rest encryption.

**What it encrypts:**
- OAuth access and refresh tokens for **all** providers (Google, GitHub, Okta, Slack, Atlassian)
- Third-party API credentials configured via Admin UI
- Any integration tokens stored for user accounts

**Why it's a Tier 1 secret (SST-only):**
This key **cannot** be configured via the Admin UI because it encrypts secrets stored in the database. Storing it in the database would create a circular dependency where the key needed to decrypt data is itself encrypted in that data.

**Format requirement:** Must be exactly 64 hexadecimal characters (32 bytes for AES-256-GCM encryption). The `openssl rand -hex 32` command generates exactly this format.

:::warning If This Key Is Lost or Changed
- All stored OAuth tokens become undecryptable
- Users must re-authenticate with **all** connected services (Google, Slack, Atlassian, etc.)
- All API credentials configured via Admin UI must be re-entered
:::

:::warning JWT_SECRET Minimum Length
`JWT_SECRET` should be at least 32 characters for security. Shorter values will work but trigger a warning in System Health. The `openssl rand -base64 48` command generates a 64-character string.
:::

:::danger Do Not Rotate During Migration
During domain migration:
- **DO NOT rotate** `SESSION_SECRET` — invalidates all active sessions
- **DO NOT rotate** `JWT_SECRET` — breaks OAuth state tokens
- **DO NOT rotate** `SECRET_ENCRYPTION_KEY` — requires re-encrypting stored tokens
:::

---

## Email Configuration (MAIL_*)

Required for platform email (one-time login codes, notifications):

| Secret | Description | Example |
|--------|-------------|---------|
| `MAIL_HOST` | SMTP server hostname | `email-smtp.us-east-1.amazonaws.com` |
| `MAIL_PORT` | SMTP port (typically 465 for SSL) | `465` |
| `MAIL_USERNAME` | SMTP username | `AKIA...` (SES credentials) |
| `MAIL_PASSWORD` | SMTP password | From SES SMTP credentials |
| `MAIL_FROM` | Sender email address | `noreply@yourdomain.com` |
| `SUPPORT_EMAIL` | Support contact email | `support@yourdomain.com` |

**Example with Amazon SES:**
```bash
pnpm sst secret set MAIL_HOST email-smtp.us-east-1.amazonaws.com --stage <stage>
pnpm sst secret set MAIL_PORT 465 --stage <stage>
pnpm sst secret set MAIL_USERNAME "AKIA..." --stage <stage>
pnpm sst secret set MAIL_PASSWORD "your-ses-smtp-password" --stage <stage>
pnpm sst secret set MAIL_FROM "noreply@yourdomain.com" --stage <stage>
```

---

## Database Configuration

| Secret/Env | Description | Values |
|------------|-------------|--------|
| `MONGODB_URI` | Database connection string | `mongodb+srv://...` |
| `MAIN_DB_TYPE` | Database type | `MongoAtlas` (default) or `DocumentDB` |

```bash
pnpm sst secret set MONGODB_URI "mongodb+srv://user:pass@cluster.mongodb.net/dbname" --stage <stage>

# For DocumentDB users only:
pnpm sst secret set MAIN_DB_TYPE DocumentDB --stage <stage>
```

---

## OAuth Providers

### Google OAuth

| Secret | Description |
|--------|-------------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |

Callback URLs:
- Login: `https://app.yourdomain.com/api/auth/google/callback`
- Drive: `https://app.yourdomain.com/google-drive/callback`

### GitHub OAuth

| Secret | Description |
|--------|-------------|
| `GITHUB_CLIENT_ID` | GitHub OAuth client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret |

Callback URL: `https://app.yourdomain.com/api/auth/github/callback`

### Okta (Enterprise SSO)

| Secret | Description | Example |
|--------|-------------|---------|
| `OKTA_AUDIENCE` | Okta domain URL | `https://your-domain.okta.com` |
| `OKTA_CLIENT_ID` | Okta OAuth client ID | From Okta admin console |
| `OKTA_CLIENT_SECRET` | Okta OAuth client secret | From Okta admin console |

:::warning JWT_SECRET Required
Okta SSO requires `JWT_SECRET` to be set. Without it, login will fail with `error=okta_setup_failed`.
:::

Callback URL: `https://app.yourdomain.com/api/auth/okta/callback`

### Microsoft OAuth

| Secret | Description |
|--------|-------------|
| `MICROSOFT_CLIENT_ID` | Microsoft OAuth client ID |
| `MICROSOFT_CLIENT_SECRET` | Microsoft OAuth client secret |

---

## Stripe (Optional)

| Secret | Description |
|--------|-------------|
| `STRIPE_SECRET_KEY` | Stripe API secret key |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret |

Webhook URL: `https://app.yourdomain.com/api/stripe/webhook`

---

## Slack Integration (Optional)

| Secret | Description |
|--------|-------------|
| `SLACK_CLIENT_ID` | Slack app client ID |
| `SLACK_CLIENT_SECRET` | Slack app client secret |
| `SLACK_SIGNING_SECRET` | Request signature verification |
| `SLACK_APP_ID` | Slack app ID |

Callback URLs:
- Workspace: `https://app.yourdomain.com/api/slack/oauth/callback`
- User link: `https://app.yourdomain.com/api/slack/oauth/user-link/callback`

---

## Verifying Configuration

### System Health Dashboard

After deployment, verify configuration via **Admin > General Ops > System Health**:

1. Log in as an admin user
2. Navigate to Admin > General Ops > System Health
3. Check status indicators for each integration
4. Use "Send Test Email" to verify SMTP

### Command Line

List configured secrets:

```bash
pnpm sst secret list | grep -E "MAIL_|MAIN_DB|STRIPE_|SESSION_|JWT_|OKTA_|GOOGLE_|GITHUB_" --stage <stage>
```

---

## Troubleshooting

### "okta_setup_failed" Error

**Cause:** Missing `JWT_SECRET`

**Fix:**
```bash
pnpm sst secret set JWT_SECRET "$(openssl rand -base64 48)" --stage <stage>
```

### "callback_error" After Okta Login

**Cause:** `SECRET_ENCRYPTION_KEY` is missing or has invalid format (must be exactly 64 hex characters)

**Symptoms:**
- Okta redirects successfully to B4M callback
- Error page shows `callback_error`
- CloudWatch logs show: `Encryption key must be 64 hex characters (32 bytes)`

**Fix:**
```bash
pnpm sst secret set SECRET_ENCRYPTION_KEY "$(openssl rand -hex 32)" --stage <stage>
```

:::tip Check Format in System Health
The System Health page (**Admin > General Ops > System Health**) validates the format of `SECRET_ENCRYPTION_KEY`. If it shows as "Not Configured" or has a format warning, regenerate it with the command above.
:::

### Token Encryption Error After OAuth

**Cause:** Missing `SECRET_ENCRYPTION_KEY`

**Fix:**
```bash
pnpm sst secret set SECRET_ENCRYPTION_KEY "$(openssl rand -hex 32)" --stage <stage>
```

### Email Not Sending

**Cause:** Missing `MAIL_*` secrets or SES not verified

**Fix:**
1. Set all `MAIL_*` secrets
2. Verify domain in SES console
3. Request SES production access if in sandbox

### "Retryable writes are not supported"

**Cause:** Using DocumentDB without setting `MAIN_DB_TYPE`

**Fix:**
```bash
pnpm sst secret set MAIN_DB_TYPE DocumentDB --stage <stage>
```

---

## Key Management

### When to Rotate Secrets

| Secret | Rotate When | Impact |
|--------|-------------|--------|
| `SESSION_SECRET` | Suspected compromise | All users logged out |
| `JWT_SECRET` | Suspected compromise | All API tokens invalidated |
| `SECRET_ENCRYPTION_KEY` | Key compromise, compliance requirement | All OAuth integrations require re-authentication |

### SECRET_ENCRYPTION_KEY Rotation

:::danger Rotation Invalidates All Stored Secrets
Rotating `SECRET_ENCRYPTION_KEY` makes all previously encrypted data unreadable. This is a destructive operation that requires users to re-authenticate with all OAuth providers and re-enter all Admin UI-configured credentials.
:::

**When rotation may be required:**
- Key compromise (suspected or confirmed)
- Personnel changes (principle of least privilege)
- Compliance requirements mandating periodic rotation

**Emergency rotation procedure:**

1. **Notify users** - Warn about upcoming integration disconnection
2. **Generate new key:** `openssl rand -hex 32`
3. **Set new secret:**
   ```bash
   pnpm sst secret set SECRET_ENCRYPTION_KEY "<new-key>" --stage <stage>
   ```
4. **Deploy** to apply the new key
5. **Users re-authenticate** - Each user must reconnect their OAuth integrations
6. **Re-enter Admin UI secrets** - All API keys configured via Admin UI must be re-entered

### If SECRET_ENCRYPTION_KEY Is Compromised

**Immediate actions (P0 - Critical):**

1. **Rotate the key immediately** using the procedure above
2. **Revoke dependent credentials at the source:**
   - Rotate OAuth client secrets at each provider (Google, GitHub, Okta, Slack)
   - Rotate API keys (Stripe, AI providers, etc.) at their respective dashboards
   - These must be rotated at the provider AND re-entered in B4M
3. **Audit access** - Review CloudWatch logs for unusual activity
4. **Document** - Create incident report per your security procedures

**Why rotating dependent credentials matters:**
An attacker with the encryption key could have decrypted stored tokens. Even after key rotation, those tokens may still be valid at the OAuth provider until revoked at the source.

### If SECRET_ENCRYPTION_KEY Is Lost

**Impact:** All database-stored secrets become permanently unreadable. No recovery is possible without the original key.

**Recovery procedure:**
1. Generate a new key: `openssl rand -hex 32`
2. Set the new key via SST
3. Re-configure ALL integrations (OAuth providers, SMTP, Stripe, AI providers)
4. Users must re-link their OAuth accounts

**Prevention:**
- Store key backup in a secure, separate location (e.g., corporate password vault)
- Document key location in disaster recovery runbook

### Compliance Mapping

| Framework | Control | How SECRET_ENCRYPTION_KEY Supports |
|-----------|---------|-----------------------------------|
| SOC 2 | CC6.1 (Encryption) | Application-level encryption at rest for OAuth tokens |
| GDPR | Art. 32 (Security of processing) | Technical measure protecting authentication credentials |

---

## See Also

- [Identity Providers](/features/identity-providers) - Configure Okta SSO via Admin UI instead of SST secrets

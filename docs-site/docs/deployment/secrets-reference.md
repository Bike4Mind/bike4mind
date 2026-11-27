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

:::warning If This Key Is Lost, or Changed Without Keeping the Previous Key
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

## Signing Secret (Optional)

Signed image URLs, hashed telemetry identifiers and purge receipts use their own secret instead of `SECRET_ENCRYPTION_KEY`. Each purpose derives a separate key from the one secret. Both secrets default to `not-configured`; while `HMAC_SIGNING_SECRET` is unset, signatures keep using `SECRET_ENCRYPTION_KEY`.

| Secret | Description | Format | How to Generate |
|--------|-------------|--------|-----------------|
| `HMAC_SIGNING_SECRET` | Root secret for signatures; per-purpose keys are derived from it | Any string (64 hex characters recommended) | `openssl rand -hex 32` |
| `HMAC_SIGNING_SECRET_PREVIOUS` | The secret that signed older values while they are still honoured (see below) | Same as above | The old value of the secret being replaced |

```bash
pnpm sst secret set HMAC_SIGNING_SECRET "$(openssl rand -hex 32)" --stage <stage>
```

When you set `HMAC_SIGNING_SECRET` for the first time, copy the secret that signed existing values into `HMAC_SIGNING_SECRET_PREVIOUS`. That is the value of `SECRET_ENCRYPTION_KEY` for a stage that never had a dedicated secret; leave `SECRET_ENCRYPTION_KEY` itself unchanged, since it still encrypts stored data. Values signed with the previous secret keep verifying while it stays set, and new values are signed with the new one. Keep it set for at least 90 days: telemetry export and deletion find a user's records only under the keys still configured, and telemetry is kept for 90 days. Once nothing signed with the old secret needs to verify, clear `HMAC_SIGNING_SECRET_PREVIOUS`.

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

### Sign in with Apple

| Secret | Description |
|--------|-------------|
| `APPLE_CLIENT_ID` | Sign in with Apple Services ID (leave unset to disable Sign in with Apple) |
| `APPLE_TEAM_ID` | Apple Developer team ID |
| `APPLE_KEY_ID` | Key ID of the Sign in with Apple private key |
| `APPLE_PRIVATE_KEY` | Contents of the `.p8` private key (PEM) |

Callback URL: `https://app.yourdomain.com/api/auth/apple/callback`

Sign in with Apple stays off unless all four secrets are set and the private key is a valid EC key. In the Apple Developer account, register a Services ID, add the callback URL above as its return URL, and create a Sign in with Apple key. Set the key with its contents, not its file path: `pnpm sst secret set APPLE_PRIVATE_KEY "$(cat AuthKey_XXXX.p8)" --stage <stage>`.

:::note Private email relay
People who choose Hide My Email get an address at `privaterelay.appleid.com`. Apple only forwards mail to these addresses from sender domains or addresses registered under your Apple Developer account's email source configuration. Register the domain your stage sends mail from, or these users will not receive one-time codes, billing or notification emails.
:::

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

## Push Notifications (Optional)

APNs push delivery for first-party native clients, using token-based (`.p8`) authentication. Each secret defaults to `not-configured`; leave any one of them unset and push is off end to end (no events are published and the delivery handler no-ops).

| Secret | Description |
|--------|-------------|
| `APNS_KEY_ID` | Key ID of the APNs authentication key |
| `APNS_TEAM_ID` | Apple Developer team ID |
| `APNS_KEY` | Contents of the `.p8` private key (PEM; newlines may be escaped as `\n`) |
| `APNS_TOPIC` | Bundle ID of the native client, sent as `apns-topic` |

```bash
pnpm sst secret set APNS_KEY_ID <key-id> --stage <stage>
pnpm sst secret set APNS_TEAM_ID <team-id> --stage <stage>
pnpm sst secret set APNS_KEY "$(cat AuthKey_<key-id>.p8)" --stage <stage>
pnpm sst secret set APNS_TOPIC <bundle-id> --stage <stage>
```

A wrong key, team, key ID or topic is logged at error level by the delivery handler as a server configuration error; registered device tokens are not deleted because of it.

### Android (FCM)

Android devices are notified through Firebase Cloud Messaging (HTTP v1 API), independently of APNs: either provider alone is enough for push to be on, and a provider left unset only turns off its own platform.

| Secret | Description |
|--------|-------------|
| `FCM_SERVICE_ACCOUNT` | The Firebase service account JSON (Project settings -> Service accounts -> Generate new private key), verbatim. Defaults to `not-configured` |

```bash
pnpm sst secret set FCM_SERVICE_ACCOUNT "$(cat <service-account>.json)" --stage <stage>
```

The service account needs permission to send FCM messages (the Firebase Admin SDK service account has it; for a custom one, grant the Firebase Cloud Messaging Admin role and enable the Firebase Cloud Messaging API on the project). A malformed JSON value, a wrong project or a rejected credential is logged at error level by the delivery handler as a server configuration error; registered device tokens are deleted only when FCM answers `UNREGISTERED`.

The Android app must be built against the same Firebase project as the service account; its client config is supplied at build time and is not kept in version control.

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
| `SECRET_ENCRYPTION_KEY` | Key compromise, compliance requirement | None when you follow the rotation procedure below |

### SECRET_ENCRYPTION_KEY Rotation

You rotate this key without disconnecting integrations by keeping the old key readable while stored values move to the new one. The app reads every stored value with `SECRET_ENCRYPTION_KEY` first and `SECRET_ENCRYPTION_KEY_PREVIOUS` second, and always writes with `SECRET_ENCRYPTION_KEY`.

Reading a value does not re-encrypt it. A stored value moves to the new key only when the re-encrypt command rewrites it, so the previous key must stay configured until that command has verified every value.

**When rotation may be required:**
- Key compromise (suspected or confirmed)
- Personnel changes (principle of least privilege)
- Compliance requirements mandating periodic rotation

**Rotation procedure:**

1. **Keep the old key readable, then set the new one:**
   ```bash
   pnpm sst secret set SECRET_ENCRYPTION_KEY_PREVIOUS "<current-key>" --stage <stage>
   pnpm sst secret set SECRET_ENCRYPTION_KEY "$(openssl rand -hex 32)" --stage <stage>
   ```
2. **Deploy** so every function and service loads both keys.
3. **Preview the re-encrypt**, which writes nothing:
   ```bash
   pnpm sst shell --stage <stage> -- pnpm --filter @bike4mind/scripts migrate:reencrypt-stored-secrets --dry-run
   ```
4. **Run the re-encrypt.** It rewrites each value that is still under the previous key. You can stop it and run it again; a second run rotates 0:
   ```bash
   pnpm sst shell --stage <stage> -- pnpm --filter @bike4mind/scripts migrate:reencrypt-stored-secrets
   ```
5. **Verify with the new key alone:**
   ```bash
   pnpm sst shell --stage <stage> -- pnpm --filter @bike4mind/scripts migrate:reencrypt-stored-secrets --verify
   ```
6. **Clear the previous key** only after verify exits `0`, then deploy again:
   ```bash
   pnpm sst secret set SECRET_ENCRYPTION_KEY_PREVIOUS "not-configured" --stage <stage>
   ```

The command prints one line of counts per stored field and a total. It never prints a stored value or a document id.

| Exit code | Meaning |
|-----------|---------|
| `0` | Every stored value is under the current key |
| `1` | Some values changed while they were being rewritten (`conflicts`): run the command again. Or no configured key opens some values (`unreadable`): a rerun does not change those, so find out why before you clear the previous key |
| `2` | Usage or connection error, or no encrypted values were found (wrong or empty database) |

:::warning Do Not Clear the Previous Key Early
Until verify exits `0`, some stored values can only be read with `SECRET_ENCRYPTION_KEY_PREVIOUS`. Clearing it before then makes those values unreadable.
:::

:::note One Rotation at a Time
Do not rotate `JWT_SECRET` and `SECRET_ENCRYPTION_KEY` in the same window. Finish one, including verify, before you start the other.
:::

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

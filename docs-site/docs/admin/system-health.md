---
title: System Health
description: Monitor and diagnose critical service configurations with real-time health checks
sidebar_position: 15
tags: [admin, health, monitoring, diagnostics]
---

# System Health

The System Health tab provides a diagnostic dashboard for monitoring the configuration status of critical platform services. It is especially useful for fork deployments where administrators may not have direct access to CloudWatch logs. The dashboard auto-refreshes every 30 seconds.

## Dashboard Overview

The System Health page displays cards for each major service category:

- **Email Configuration** -- SMTP/SES email delivery status
- **Database Configuration** -- MongoDB/DocumentDB connection health
- **OAuth Providers** -- Authentication provider connectivity (Google, GitHub, Okta)

A manual **Refresh** button is available in the header to force an immediate status check.

## Email Configuration

### Status Display

The email configuration card shows:

- **Overall Status** -- A chip indicating whether email is configured or missing
- **Required Secrets Status** -- A grid showing each email-related secret and whether it is present

When email is not configured, a warning alert explains the impact: users will not receive one-time login codes, invitation emails, or other system notifications.

### Missing Secrets

If any secrets are missing, an alert lists them with instructions for setting them:

```bash
npx sst secret set MAIL_HOST smtp.example.com --stage <stage>
```

### Send Test Email

When email is configured, the **Send Test Email** button sends a test message to the admin email address. Results display:

| Outcome | Information Shown |
|---------|------------------|
| Success | Recipient address, message ID, timestamp |
| Failure | Error message, actionable guidance, timestamp |

### Email Error Guidance

The system provides specific troubleshooting guidance for common email errors:

| Error Type | Guidance |
|-----------|----------|
| Identity not verified | Directs to AWS SES Verified Identities console for the detected region |
| Recipient rejected | Indicates possible SES sandbox mode; suggests requesting production access |
| Connection refused | Check MAIL_HOST and MAIL_PORT configuration |
| Authentication failed | Verify MAIL_USERNAME and MAIL_PASSWORD |
| Timeout | Check MAIL_HOST and SMTP port accessibility |

## Database Configuration

### Status Display

The database card shows:

- **Database Type** -- MongoDB or DocumentDB
- **Connection Status** -- Connected or Disconnected
- **Ready State** -- Disconnected (0), Connected (1), Connecting (2), or Disconnecting (3)

When DocumentDB is detected, an informational alert reminds administrators to set `MAIN_DB_TYPE=DocumentDB` to disable retryable writes.

### Test Connection

The **Test Connection** button executes a ping command against the database. Results include:

| Outcome | Information Shown |
|---------|------------------|
| Success | Latency in milliseconds, timestamp |
| Failure | Error message, timestamp |

## OAuth Providers

### Supported Providers

The OAuth section tests connectivity for three providers:

| Provider | Required Secrets |
|----------|-----------------|
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| Okta | `OKTA_AUDIENCE`, `OKTA_CLIENT_ID`, `OKTA_CLIENT_SECRET` |

Each provider card shows its configuration status and lists any missing secrets.

### Okta-Specific Features

The Okta card provides additional diagnostic information:

- **Config Source** -- Indicates whether the active configuration comes from the database (IDP) or SST secrets
- **Override Notice** -- When both database and SST configurations exist, an alert notes that the database config takes precedence
- **JWT_SECRET Warning** -- If JWT_SECRET is missing, a warning explains that Okta login will fail with `error=okta_setup_failed` and provides the command to generate and set it

### Testing OAuth Providers

Each provider has a **Test** button that verifies connectivity to the provider's endpoints. Test results display:

| Outcome | Information Shown |
|---------|------------------|
| Success | Latency, endpoint URL, config source (for Okta), timestamp |
| Failure | Error message, actionable guidance, timestamp |

### Okta Detailed Diagnostics

For Okta, successful tests display a detailed diagnostics panel with status for:

- **JWKS** -- Signing key availability and count
- **Token Endpoint** -- Reachability and client authentication acceptance
- **Userinfo Endpoint** -- Reachability and response status
- **Issuer** -- Whether the discovered issuer matches the expected URL
- **Signing** -- RS256 algorithm support

### OAuth Error Guidance

The system provides specific guidance for common OAuth errors:

| Error Type | Guidance |
|-----------|----------|
| Missing configuration | Lists the required secrets with set commands |
| Network errors | Check network connectivity and provider URL |
| Timeout | Provider may be unavailable or blocked by firewall |
| Okta 404 | Verify OKTA_AUDIENCE format (no trailing slash) |
| SSL/TLS errors | Invalid or expired certificate on provider |
| HTTP 401/403 | Verify client ID and secret |
| HTTP 5xx | Temporary issue on provider side |

## Help Section

The bottom of the page includes a help card with general troubleshooting tips:

- Check the fork setup documentation for required environment variables
- Use `npx sst secret list --stage <stage>` to see configured secrets
- For email issues, verify SMTP credentials and DNS records (SPF, DKIM, DMARC)
- For database issues, ensure MongoDB/DocumentDB connection strings are correct

## Best Practices

- **Regular Monitoring** -- The 30-second auto-refresh keeps the dashboard current; use the manual refresh after making configuration changes
- **Test After Changes** -- Always run the test buttons after updating secrets or configuration to verify connectivity
- **Fork Deployments** -- Use this dashboard as a first-line diagnostic tool before diving into CloudWatch logs
- **SES Setup** -- Verify both sender and recipient email addresses in SES before testing email delivery

## Related Articles

- [Admin Settings](./admin-settings.md)
- [LLM Dashboard](./llm-dashboard.md)

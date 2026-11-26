---
title: Email Setup
description: Configure email sending for your B4M deployment
sidebar_position: 1
---

# Email Setup

B4M can send transactional emails (one-time login codes, notifications) from your domain. This guide covers email configuration options.

## Do You Need Platform Email?

**Platform email** means the application sends emails **FROM** your domain (e.g., `notifications@yourdomain.com`).

| Feature | Requires Platform Email? |
|---------|-------------------------|
| One-time login codes (OTC) | Yes |
| User invitations | Yes |
| Session notifications | Yes |
| OAuth SSO-only login | No |

**Most deployments DO use platform email** for user notifications.

## Email Provider Options

### Amazon SES (Recommended)

Best for AWS-native deployments:
- Integrated with your AWS account
- Cost-effective at scale
- Requires domain verification and production access

**[Set up SES →](./ses-setup.md)**

### External SMTP (SendGrid, etc.)

If you prefer a managed email service:
- Simpler setup
- May have better deliverability out-of-box
- Additional cost

## Quick Configuration

Set these SST secrets regardless of provider:

```bash
pnpm sst secret set MAIL_HOST <smtp-host> --stage <stage>
pnpm sst secret set MAIL_PORT 465 --stage <stage>
pnpm sst secret set MAIL_USERNAME <username> --stage <stage>
pnpm sst secret set MAIL_PASSWORD <password> --stage <stage>
pnpm sst secret set MAIL_FROM "noreply@yourdomain.com" --stage <stage>
```

`MAIL_FROM` is the sender of every system email until an admin sets the **System Email Sender** (`mailFrom`) admin setting, which takes over from the next email without a deploy. Clearing the setting goes back to `MAIL_FROM`. Either value can be an address (`noreply@yourdomain.com`) or a name and address (`Your App <noreply@yourdomain.com>`).

### Personal stages

A personal stage (any stage other than `production`, `dev`, `shared-dev` or a `pr<number>` preview) can send through SES without exporting anything. At deploy time it reads two SSM String parameters from the account it deploys into:

- `/<app>/shared/mail/ses-configuration-set` - the SES configuration set name
- `/<app>/shared/mail/ses-identity` - the verified SES identity (usually a domain)

`<app>` is the SST app name (`bike4mind` unless you override it). When both exist and are non-empty, the stage deploys with `MAIL_TRANSPORT=ses` and those names, and the deploy output says so in a `[mail]` line. When either is missing, unreadable or not a plain SES name, the deploy logs a warning and stays on SMTP. `shared-dev` and the other team stages only use SES when you export `MAIL_TRANSPORT=ses`, `SES_CONFIGURATION_SET` and `SES_IDENTITY` yourself.

- Anything you export wins. Setting `MAIL_TRANSPORT`, `SES_CONFIGURATION_SET` or `SES_IDENTITY` skips the defaults entirely, so `MAIL_TRANSPORT=smtp` opts a personal stage out of SES.
- The stage's `MAIL_FROM` secret must be an address on the SES identity's domain. The `mailFrom` admin setting is only saved with an address on the same domain as `MAIL_FROM`.
- While the account's SES is in sandbox mode, recipients must be verified addresses too.

## DNS Records for Deliverability

Regardless of provider, add these DNS records:

### SPF Record

Authorizes your email provider to send on your behalf:

```
Type: TXT
Name: @ (or yourdomain.com)
Value: v=spf1 include:amazonses.com ~all
```

(Replace `amazonses.com` with your provider's SPF include)

### DKIM Records

Your provider will generate DKIM records during domain verification. Add all provided CNAME records.

### DMARC Record

Email authentication policy:

```
Type: TXT
Name: _dmarc
Value: v=DMARC1; p=none; rua=mailto:dmarc-reports@yourdomain.com
```

See [Domain Migration Guide](../domain-migration.md#email-configuration-if-using-platform-email) for DMARC progression recommendations.

## Verification

After configuration:

1. **Admin Panel**: Go to Admin > System Health > Email
2. **Send Test**: Use the "Send Test Email" button
3. **Check Headers**: Verify SPF/DKIM pass in received email headers

## Troubleshooting

### Emails Not Sending

1. Check `MAIL_*` secrets are set correctly
2. Verify domain in your email provider
3. Check CloudWatch logs for errors

### Emails Going to Spam

1. Verify DKIM records are correct
2. Add SPF record
3. Start DMARC in monitoring mode (`p=none`)
4. Check sender reputation

### "Email service temporarily unavailable"

This indicates `MAIL_*` secrets are not configured. See [Secrets Reference](../secrets-reference.md).

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

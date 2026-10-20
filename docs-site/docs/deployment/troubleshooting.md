---
title: Troubleshooting
description: Common deployment issues and solutions
sidebar_position: 99
---

# Troubleshooting

Common issues and solutions for B4M fork deployments.

## Local Tooling Issues

### pnpm: command not found

**Cause:** pnpm is not installed globally.

**Fix:**
```bash
npm install -g pnpm
# Restart your terminal after installation
```

### sst: command not found / Cannot find module 'sst'

**Cause:** Dependencies not installed.

**Fix:**
```bash
pnpm install
```

SST is installed as a dev dependency and not globally.

### AWS profile not found

**Cause:** The AWS profile required for your environment is not configured in `~/.aws/config`.

**Symptoms:**
- `The config profile (X) could not be found`
- `Error: Profile not found`

**Fix:** Add the appropriate profile to `~/.aws/config`. See [Local Tooling Prerequisites](./prerequisites.md#local-tooling-prerequisites).

### SSO token expired

**Cause:** Your AWS SSO session has expired.

**Symptoms:**
- `Error loading SSO Token: Token for ... does not exist`
- `The SSO session has expired or is otherwise invalid`

**Fix:**
```bash
aws sso login --profile your-profile-name
```

### Node.js version mismatch

**Cause:** Wrong Node.js version installed.

**Symptoms:**
- Unexpected syntax errors
- Module resolution errors
- Node.js version check fails

**Fix:**
```bash
nvm install 20
nvm use 20
```

---

## Authentication Issues

### "okta_setup_failed" Error

**Cause:** Missing `JWT_SECRET` in SST secrets

**Fix:**
```bash
pnpm sst secret set JWT_SECRET "$(openssl rand -base64 48)" --stage <stage>
```

Then redeploy. Verify in Admin > System Health.

### "Invalid redirect URI" (OAuth)

**Cause:** OAuth provider missing callback URL for new domain

**Fix:** Add exact callback URL to provider console (no trailing slashes):
- Google: `https://app.yourdomain.com/api/auth/google/callback`
- Okta: `https://app.yourdomain.com/api/auth/okta/callback`
- GitHub: `https://app.yourdomain.com/api/auth/github/callback`

### Token Encryption Error After OAuth

**Cause:** Missing `SECRET_ENCRYPTION_KEY`

**Fix:**
```bash
pnpm sst secret set SECRET_ENCRYPTION_KEY "$(openssl rand -hex 32)" --stage <stage>
```

### "State mismatch" / "Invalid or expired state"

**Cause:** Session secret changed or multi-tab issue

**Fix:**
1. Ensure `SESSION_SECRET` hasn't changed
2. Close other browser tabs
3. Clear cookies and retry

---

## DNS Issues

### Site Unreachable

**Cause:** DNS not propagated

**Check:**
```bash
dig app.yourdomain.com +short
# Should return CloudFront distribution
```

**Fix:** Wait for TTL expiration (up to 48 hours for nameserver changes)

### Certificate Errors

**Cause:** ACM certificate pending validation

**Check:** AWS Console > ACM > Certificates

**Fix:** Ensure DNS validation records are added to Route53

### Wrong Site Loads

**Cause:** Cached DNS

**Fix:**
1. Clear browser cache
2. Use `dig` to verify correct resolution
3. Try incognito/private browsing

---

## Deployment Issues

### "Hosted zone not found"

**Cause:** Route53 hosted zone not accessible or misconfigured

**Fix:**
1. Verify `HOSTED_ZONE` GitHub variable matches your Route53 zone domain name exactly (e.g., `example.com`, not the zone ID)
2. Verify the hosted zone exists in the target AWS account
3. Verify IAM role has `route53:ListHostedZonesByName` permission
4. Check that nameservers have propagated if the zone was recently created

### "Certificate validation failed"

**Cause:** DNS zone mismatch

**Fix:** Verify `HOSTED_ZONE` matches your Route53 zone name exactly

### Lambda Timeout During Deploy

**Cause:** Large bundle or network issues

**Fix:**
1. Check network connectivity
2. Increase CI/CD timeout settings
3. Review bundle size

---

## Database Issues

### "Retryable writes are not supported"

**Cause:** Using DocumentDB without setting `MAIN_DB_TYPE`

**Fix:**
```bash
pnpm sst secret set MAIN_DB_TYPE DocumentDB --stage <stage>
```

### Database Connection Timeout

**Causes:**
1. Security group blocking access
2. VPC peering not configured
3. Incorrect connection string

**Fix:**
1. Verify Lambda security group allows outbound to database
2. Check VPC peering or VPN configuration
3. Verify `MONGODB_URI` connection string

---

## Email Issues

### "Email service temporarily unavailable"

**Cause:** `MAIL_*` secrets not configured

**Fix:** Set all email secrets. See [Secrets Reference](./secrets-reference.md#email-configuration-mail_).

### Emails Not Sending

**Check:**
1. Admin > System Health > Email status
2. SES domain verification status
3. SES sandbox mode (can only send to verified addresses)

**Fix:**
1. Complete SES domain verification
2. Request SES production access
3. Verify all `MAIL_*` secrets are set

### Emails Going to Spam

**Check:**
```bash
# In received email headers, look for:
# Authentication-Results: spf=pass dkim=pass dmarc=pass
```

**Fix:**
1. Add SPF record to DNS
2. Verify DKIM records from SES
3. Add DMARC record (start with `p=none`)

---

## S3/CORS Issues

### CORS Preflight Returns 403

**Cause:** Domain not in S3 CORS allowlist

**Note:** CORS is configured automatically by SST based on `SERVER_DOMAIN`. If you see this error:

**Fix:**
1. Verify `SERVER_DOMAIN` is set correctly
2. Redeploy to update CORS configuration
3. Invalidate CloudFront cache

### Upload Succeeds but App Errors

**Cause:** Missing headers in CORS `ExposeHeaders`

**Note:** This should be automatic. If persisting, check infra/buckets.ts configuration.

---

## Performance Issues

### Slow First Request

**Cause:** Lambda cold start

**Fix:** Enable warming for production:
- Set `ENABLE_WARMING=true` in environment variables
- Configure provisioned concurrency for critical functions

### WebSocket Disconnects

**Cause:** Various network or timeout issues

**Check:**
1. Browser network tab for WebSocket errors
2. CloudWatch logs for Lambda errors
3. API Gateway metrics

---

## Getting Help

If issues persist:

1. **Check CloudWatch Logs** for detailed error messages
2. **Use System Health Panel** (Admin > General Ops > System Health)
3. **Review this troubleshooting guide** for similar issues
4. **Contact Bike4Mind support** with:
   - Error messages from logs
   - Steps to reproduce
   - Environment details (stage, region)

---
title: AWS SES Setup
description: Step-by-step guide for setting up AWS SES for email sending and ingestion
sidebar_position: 2
---

# AWS SES Domain Setup Guide

This guide provides step-by-step instructions for setting up AWS SES for email sending and the optional Email-to-Platform Ingestion feature.

## Prerequisites

- AWS Account with admin access
- Domain ownership (e.g., `bike4mind.com` or customer domain)
- Access to DNS management for the domain

## Phase 1: Domain Verification

### Step 1: Verify Domain in AWS SES

1. **Navigate to AWS SES Console**
   - Go to: https://console.aws.amazon.com/ses/
   - Region: Select your preferred region (e.g., `us-east-1`)

2. **Create Domain Identity**
   - Click "Verified identities" in the left sidebar
   - Click "Create identity"
   - Select "Domain" as identity type
   - Enter domain: `bike4mind.com` (or `SERVER_DOMAIN` from environment)
   - Check "Assign a default configuration set" (optional)
   - Click "Create identity"

3. **Configure DNS Records**
   AWS SES will provide DNS records to add to your domain:

   **DKIM Records (3 CNAME records):**
   ```
   Name: [random-string]._domainkey.bike4mind.com
   Type: CNAME
   Value: [random-string].dkim.amazonses.com

   (Repeat for all 3 DKIM records)
   ```

   **Domain Verification (TXT record):**
   ```
   Name: _amazonses.bike4mind.com
   Type: TXT
   Value: [verification-token]
   ```

   **MX Record (for receiving emails):**
   ```
   Name: app.bike4mind.com
   Type: MX
   Priority: 10
   Value: inbound-smtp.[region].amazonaws.com
   ```

4. **Add DNS Records**
   - Log into your DNS provider (e.g., Route53, Cloudflare, GoDaddy)
   - Add all DNS records provided by AWS SES
   - Wait for DNS propagation (can take up to 48 hours, usually < 30 minutes)

5. **Verify Domain Status**
   - Return to AWS SES Console → "Verified identities"
   - Check status of domain identity
   - Status should change from "Pending verification" to "Verified"

### Step 2: Request Production Access

**IMPORTANT:** AWS SES starts in "Sandbox Mode" with limitations:
- Can only send to verified email addresses
- Can only send 200 emails/day
- Maximum send rate: 1 email/second

**To remove limitations:**

1. **Submit Production Access Request**
   - Go to: AWS SES Console → "Account dashboard"
   - Click "Request production access"
   - Fill out the form:
     - **Mail type**: Transactional
     - **Website URL**: https://bike4mind.com
     - **Use case description**:
       ```
       Email-to-Platform Ingestion Feature

       We are implementing an email ingestion system that allows users to
       forward emails to the platform for AI analysis, knowledge management,
       and team collaboration. Users will have unique platform email addresses
       (e.g., user.name@app.bike4mind.com) where they can send emails for:

       - Automatic AI summarization and entity extraction
       - Email thread tracking and conversation management
       - Attachment processing and link scraping
       - Privacy-controlled sharing with team members
       - Embargo scheduling for time-sensitive content

       We need production access to support our user base sending emails to
       their personal platform addresses.
       ```
     - **Process description**:
       ```
       1. User forwards email to their platform address
       2. AWS SES receives email → S3 bucket storage
       3. Lambda function parses email (sender validation, content extraction)
       4. Email stored in MongoDB for user access
       5. AI analysis triggered asynchronously
       6. User can view/search/share emails in platform UI

       We enforce sender validation to prevent unauthorized emails.
       ```
     - **Bounce/complaint handling**:
       ```
       We handle bounces and complaints via:
       - SNS topics for bounce/complaint notifications
       - Automatic sender blocklist updates
       - User notifications for failed deliveries
       - Suppression list management in AWS SES
       ```
   - Submit request
   - AWS typically responds within 24 hours

## Phase 2: Inbound Email Configuration

### Step 3: Create S3 Bucket for Email Storage

1. **Create S3 Bucket**
   - Go to: AWS S3 Console
   - Click "Create bucket"
   - Bucket name: `bike4mind-email-ingestion-[region]`
   - Region: Same as SES region
   - Block public access: **Enabled** (keep emails private)
   - Versioning: Disabled
   - Encryption: Enable (SSE-S3 or SSE-KMS)
   - Click "Create bucket"

2. **Create Bucket Policy**
   - Go to bucket → "Permissions" → "Bucket Policy"
   - Add policy to allow SES to write emails:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "AllowSESPuts",
         "Effect": "Allow",
         "Principal": {
           "Service": "ses.amazonaws.com"
         },
         "Action": "s3:PutObject",
         "Resource": "arn:aws:s3:::bike4mind-email-ingestion-[region]/*",
         "Condition": {
           "StringEquals": {
             "AWS:SourceAccount": "[YOUR-AWS-ACCOUNT-ID]"
           },
           "StringLike": {
             "AWS:SourceArn": "arn:aws:ses:[region]:[YOUR-AWS-ACCOUNT-ID]:*"
           }
         }
       }
     ]
   }
   ```

3. **Configure Lifecycle Policy (Optional)**
   - Go to bucket → "Management" → "Lifecycle rules"
   - Create rule: "Delete raw emails after 30 days"
   - Rule scope: Prefix `raw-emails/`
   - Expiration: 30 days after creation
   - Click "Create rule"

### Step 4: Create SQS Queue for Email Processing

1. **Create SQS Queue**
   - Go to: AWS SQS Console
   - Click "Create queue"
   - Queue name: `email-ingestion-queue`
   - Type: Standard
   - Visibility timeout: 300 seconds (5 minutes)
   - Message retention: 4 days
   - Receive message wait time: 20 seconds (long polling)
   - Click "Create queue"

2. **Configure Queue Policy**
   - Go to queue → "Access policy" → "Edit"
   - Add policy to allow SES to send messages:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Service": "ses.amazonaws.com"
         },
         "Action": "sqs:SendMessage",
         "Resource": "arn:aws:sqs:[region]:[account-id]:email-ingestion-queue",
         "Condition": {
           "StringEquals": {
             "AWS:SourceAccount": "[YOUR-AWS-ACCOUNT-ID]"
           },
           "StringLike": {
             "AWS:SourceArn": "arn:aws:ses:[region]:[YOUR-AWS-ACCOUNT-ID]:*"
           }
         }
       }
     ]
   }
   ```

### Step 5: Create SES Receipt Rule

1. **Create Receipt Rule Set**
   - Go to: AWS SES Console → "Email receiving" → "Rule sets"
   - Click "Create rule set"
   - Rule set name: `email-ingestion-rules`
   - Click "Create rule set"
   - Click "Set as active" to activate the rule set

2. **Create Receipt Rule**
   - Click "Create rule" within the rule set
   - Rule name: `platform-email-ingestion`

   **Recipients:**
   - Add recipient condition: `app.bike4mind.com`
   - This matches all emails sent to `*@app.bike4mind.com`

   **Actions (in order):**

   1. **S3 Action** (first action - store raw email):
      - Bucket: `bike4mind-email-ingestion-[region]`
      - Object key prefix: `raw-emails/`
      - SNS topic: None (optional: create for monitoring)

   2. **SQS Action** (second action - trigger processing):
      - Queue: `email-ingestion-queue`
      - Encoding: UTF-8

   **Rule Settings:**
   - Enabled: Yes
   - Spam and virus scanning: Enabled
   - TLS: Optional (recommended)

   - Click "Create rule"

## Phase 3: Email Parser Lambda

The Lambda function will:
1. Poll the SQS queue for new email notifications
2. Download raw email from S3
3. Parse email with mailparser
4. Validate sender against user's `authorizedEmailAddresses`
5. Store parsed email in MongoDB (IngestedEmailModel)
6. Trigger AI analysis pipeline


## Testing the Setup

### Manual Test Email

Once DNS records are verified and SES rules are active:

1. **Send Test Email**
   - From: Your personal email (add to user's `authorizedEmailAddresses`)
   - To: `testuser@app.bike4mind.com`
   - Subject: "Test Email Ingestion"
   - Body: "This is a test email to verify SES inbound email configuration."
   - Attachment: Add a small PDF or image

2. **Verify S3 Storage**
   - Go to S3 bucket: `bike4mind-email-ingestion-[region]`
   - Check `raw-emails/` folder
   - You should see a new object with the email content

3. **Verify SQS Message**
   - Go to SQS queue: `email-ingestion-queue`
   - Click "Send and receive messages" → "Poll for messages"
   - You should see a message with the S3 object key

4. **Verify Email Receipt**
   - Go to AWS SES Console → "Email receiving" → "Receipt rules"
   - Click on your rule set → Metrics
   - Check for received email count

### CloudWatch Metrics

Monitor SES email receiving:
- AWS SES Console → "Email receiving" → "Rule sets" → Your rule set → "Metrics"
- Metrics to watch:
  - **Received**: Total emails received
  - **Rejected**: Emails rejected (invalid recipient)
  - **Virus**: Emails with viruses detected
  - **Spam**: Emails marked as spam

## Environment Variables

Add to your `.env` file:

```bash
# Email Ingestion Configuration
AWS_SES_REGION=us-east-1
EMAIL_S3_BUCKET=bike4mind-email-ingestion-us-east-1
EMAIL_SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/[account-id]/email-ingestion-queue
PLATFORM_EMAIL_DOMAIN=app.bike4mind.com
```

## Multi-Tenant Configuration

For enterprise customers using different domains:

1. **Verify each customer domain** in AWS SES (repeat Phase 1)
2. **Update MX records** for each customer subdomain
3. **Update SES Receipt Rule** recipients:
   - Add multiple recipient conditions:
     - `app.bike4mind.com`
     - `app.yourcompany.com`
     - `app.customer1.com`
     - etc.
4. **Environment variable**: Use `SERVER_DOMAIN` from SST config

## Security Best Practices

1. **Sender Validation**
   - Always validate sender against `user.authorizedEmailAddresses`
   - Reject unauthorized senders with bounce notification

2. **Virus/Spam Scanning**
   - Enable AWS SES built-in virus scanning
   - Enable spam filtering in receipt rules
   - Add custom spam detection in Lambda parser

3. **Rate Limiting**
   - Implement per-user email ingestion limits
   - Track daily/weekly email counts in user model
   - Return bounce for over-limit users

4. **Data Privacy**
   - Store raw emails in encrypted S3 bucket
   - Set retention policy (auto-delete after 30 days)
   - Respect user's `visibilityLevel` settings
   - Enforce `embargoUntil` dates

5. **Access Control**
   - Use IAM roles for Lambda/SQS/S3 access (least privilege)
   - Enable CloudTrail logging for SES API calls
   - Monitor suspicious email patterns

## Troubleshooting

### DNS Verification Stuck

**Problem:** Domain identity status shows "Pending verification" for > 1 hour

**Solutions:**
- Verify DNS records are correctly added (exact values from AWS)
- Check DNS propagation: https://dnschecker.org
- Ensure no conflicting DNS records exist
- Wait up to 48 hours (usually < 30 minutes)

### Emails Not Received in S3

**Problem:** Test email sent but no S3 object created

**Check:**
1. SES receipt rule is active
2. MX record points to correct SES endpoint
3. Recipient domain matches rule condition
4. S3 bucket policy allows SES PutObject
5. Email didn't fail spam/virus scan (check SES metrics)

### SQS Queue Empty

**Problem:** Email in S3 but no SQS message

**Check:**
1. SQS action is enabled in receipt rule
2. SQS queue policy allows SES SendMessage
3. SQS visibility timeout not too short
4. Messages not consumed by another service

### Bounces/Rejections

**Problem:** Emails bouncing back to sender

**Causes:**
- Recipient email doesn't match receipt rule pattern
- Domain not verified in SES
- SES still in sandbox mode (verify recipient)
- Spam/virus scan failed

## Next Steps

After completing domain verification:

1. ✅ **Phase 1 Complete**: Domain verified, DNS configured, production access requested
2. ⏭️ **Phase 2**: Create S3 bucket, SQS queue, SES receipt rules (can do in parallel)
3. ⏭️ **Phase 3**: Build Email Parser Lambda (next task)
4. ⏭️ **Phase 4**: Build Email Integration Settings UI
5. ⏭️ **Phase 5**: End-to-end testing with real emails

---

**Related Documentation:**
- [Email Setup Overview](./index.md) - Email configuration options
- [Architecture](/deployment/architecture) - Infrastructure overview including email queues


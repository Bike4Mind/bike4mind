#!/usr/bin/env tsx
/**
 * Test Email Ingest Lambda Function
 *
 * This script tests the complete email ingestion flow by:
 * 1. Uploading a test email to S3 (emailIngestionBucket)
 * 2. Sending an S3 event notification to the email ingestion SQS queue
 * 3. SQS automatically triggers the email parser Lambda
 * 4. Lambda processes the email (validation, storage, AI analysis)
 *
 * This mimics the production flow: S3 -> SQS -> Lambda
 * This is different from testEmailIngestion.ts which calls the service layer directly.
 *
 * Usage:
 *   # Quick test with built-in template
 *   pnpm testEmailIngestLambda --from=test@example.com --to=user@app.example.com --quick
 *
 *   # Custom template file
 *   pnpm testEmailIngestLambda --from=test@example.com --to=user@app.example.com --template=./email.eml
 *
 *   # Built-in templates
 *   pnpm testEmailIngestLambda --from=... --to=... --html
 *   pnpm testEmailIngestLambda --from=... --to=... --attachment
 *   pnpm testEmailIngestLambda --from=... --to=... --newsletter
 *
 *   # With cleanup (delete test email from S3)
 *   pnpm testEmailIngestLambda --from=... --to=... --quick --cleanup
 *
 *   # Via SST shell (recommended - provides SST resource context)
 *   npx sst shell -- pnpm testEmailIngestLambda --from=... --to=... --quick
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import ora from 'ora';
import { Resource } from 'sst';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

// ============================================================================
// Constants
// ============================================================================

/**
 * AWS Region - matches the region defined in sst.config.ts
 * SST doesn't expose this through Resource, but we can reference the same value
 */
const AWS_REGION = 'us-east-2';

// ============================================================================
// CLI Arguments
// ============================================================================

const argv = await yargs(hideBin(process.argv))
  .option('from', {
    type: 'string',
    description: 'Sender email address (required)',
    demandOption: true,
  })
  .option('to', {
    type: 'string',
    description: 'Recipient platform email address (required)',
    demandOption: true,
  })
  .option('template', {
    type: 'string',
    description: 'Path to custom .eml file',
  })
  .option('quick', {
    alias: 'q',
    type: 'boolean',
    description: 'Use built-in simple text template',
    default: false,
  })
  .option('html', {
    type: 'boolean',
    description: 'Use built-in HTML template',
    default: false,
  })
  .option('attachment', {
    type: 'boolean',
    description: 'Use built-in attachment template',
    default: false,
  })
  .option('newsletter', {
    type: 'boolean',
    description: 'Use built-in newsletter template',
    default: false,
  })
  .option('cleanup', {
    type: 'boolean',
    description: 'Delete test email from S3 after invocation',
    default: false,
  })
  .option('verbose', {
    alias: 'v',
    type: 'boolean',
    description: 'Show detailed logs',
    default: false,
  })
  .help()
  .parseAsync();

// ============================================================================
// Email Templates
// ============================================================================

const EMAIL_TEMPLATES = {
  simple: {
    name: 'Simple Text Email',
    content: `From: {{FROM}}
To: {{TO}}
Subject: Test Email - Lambda Invocation Test
Message-ID: <test-lambda-simple-{{TIMESTAMP}}@test.local>
Date: {{DATE}}
Content-Type: text/plain; charset=utf-8

This is a test email sent via Lambda invocation script.

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.

Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.

This email tests the complete email ingestion flow:
- S3 upload and storage
- Lambda parsing and processing
- Sender validation and authorization
- Storage in MongoDB database
- AI analysis with Claude 3.5 Sonnet
- Email body conversion to markdown
- Attachment processing as fabFiles

Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.

Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt.

Testing timestamp: {{TIMESTAMP}}

Best regards,
Test System
`,
  },
  html: {
    name: 'HTML Email with Links',
    content: `From: {{FROM}}
To: {{TO}}
Subject: Test Email - HTML Lambda Test
Message-ID: <test-lambda-html-{{TIMESTAMP}}@test.local>
Date: {{DATE}}
MIME-Version: 1.0
Content-Type: text/html; charset=utf-8

<html>
<body>
  <h1>Lambda Test Email - HTML Format</h1>

  <p>This is an <strong>HTML</strong> email testing the Lambda function with rich formatting.</p>

  <h2>Introduction</h2>
  <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>

  <h2>Key Features Tested</h2>
  <ul>
    <li><strong>HTML formatting</strong> - Headers, paragraphs, lists</li>
    <li><strong>Links:</strong> <a href="https://bike4mind.com">Bike4Mind</a></li>
    <li><strong>Rich content</strong> for AI analysis and entity extraction</li>
    <li><strong>Markdown conversion</strong> from HTML</li>
    <li><strong>Sentiment analysis</strong> capabilities</li>
  </ul>

  <h2>Technical Details</h2>
  <p>Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>

  <blockquote style="border-left: 3px solid #ccc; padding-left: 15px; margin: 15px 0; color: #555;">
    <p>Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.</p>
  </blockquote>

  <h2>Action Items</h2>
  <ol>
    <li>Review the Lambda test results in CloudWatch Logs</li>
    <li>Check MongoDB for the ingested email document</li>
    <li>Verify AI analysis completion with Claude 3.5 Sonnet</li>
    <li>Inspect markdown conversion quality</li>
    <li>Test attachment processing pipeline</li>
  </ol>

  <p>Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt. Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet, consectetur, adipisci velit.</p>

  <hr style="margin: 20px 0; border: none; border-top: 1px solid #ccc;">

  <p><small>Testing timestamp: {{TIMESTAMP}}</small></p>

  <p>Best regards,<br>
  <strong>Test Automation System</strong></p>
</body>
</html>
`,
  },
  attachment: {
    name: 'Email with Attachment',
    content: `From: {{FROM}}
To: {{TO}}
Subject: Test Email - Lambda Test with Attachment
Message-ID: <test-lambda-attachment-{{TIMESTAMP}}@test.local>
Date: {{DATE}}
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="boundary-{{TIMESTAMP}}"

--boundary-{{TIMESTAMP}}
Content-Type: text/plain; charset=utf-8

This Lambda test email includes a text file attachment to verify the attachment processing pipeline.

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.

The attachment should be:
- Uploaded to the fabFiles S3 bucket
- Processed and converted to a fabFile
- Made searchable and viewable in the FileBrowser
- Linked to the ingested email document

Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.

Please review the attached document for additional test details and verification steps.

--boundary-{{TIMESTAMP}}
Content-Type: text/plain; name="lambda-test-document.txt"
Content-Disposition: attachment; filename="lambda-test-document.txt"

Lambda Test Document
====================

This is a test document attached to the email. It should be processed by the email ingestion Lambda and converted into a fabFile for storage and retrieval.

Test Details
------------

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.

Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.

Verification Steps
-----------------

1. Check that the attachment was uploaded to S3
2. Verify fabFile creation in MongoDB
3. Confirm file is searchable in the system
4. Test file viewing capabilities
5. Validate file metadata extraction

Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.

Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt.

Testing timestamp: {{TIMESTAMP}}
File processing test: PASSED
--boundary-{{TIMESTAMP}}--
`,
  },
  newsletter: {
    name: 'Newsletter with Tracking Pixels',
    content: `From: {{FROM}}
To: {{TO}}
Subject: Test Newsletter - Lambda Test
Message-ID: <test-lambda-newsletter-{{TIMESTAMP}}@test.local>
Date: {{DATE}}
MIME-Version: 1.0
Content-Type: text/html; charset=utf-8

<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #333; border-bottom: 2px solid #007bff; padding-bottom: 10px;">Weekly Newsletter - Lambda Test Edition</h1>

  <p>Welcome to our weekly newsletter! This edition tests the Lambda function's ability to handle complex newsletter scenarios.</p>

  <h2 style="color: #007bff;">Feature Highlights</h2>

  <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>

  <h3>What We're Testing</h3>
  <ul>
    <li><strong>Tracking pixels</strong> - Should be automatically cleaned and removed</li>
    <li><strong>Rich HTML content</strong> - Headers, paragraphs, lists, and styling</li>
    <li><strong>Links and images</strong> - External references and embedded content</li>
    <li><strong>Email newsletter detection</strong> - Identifying newsletter characteristics</li>
    <li><strong>Content extraction</strong> - Converting HTML to clean markdown</li>
  </ul>

  <img src="https://tracker.example.com/pixel.gif?id={{TIMESTAMP}}" width="1" height="1" alt="__tpx__" />
  <img src="https://analytics.example.com/open?email={{TIMESTAMP}}" width="1" height="1" style="display:none" />

  <h2 style="color: #007bff; margin-top: 30px;">Main Content</h2>

  <p>Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>

  <blockquote style="border-left: 3px solid #007bff; padding-left: 15px; margin: 20px 0; color: #555; font-style: italic;">
    "Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo."
  </blockquote>

  <p>Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt.</p>

  <h3 style="color: #28a745; margin-top: 25px;">Important Action Items</h3>
  <ol style="line-height: 1.8;">
    <li><strong>Review the Lambda test results</strong> in CloudWatch Logs</li>
    <li><strong>Check MongoDB</strong> for the ingested email document</li>
    <li><strong>Verify AI analysis completion</strong> with Claude 3.5 Sonnet</li>
    <li><strong>Inspect newsletter detection</strong> and special handling</li>
    <li><strong>Test tracking pixel removal</strong> functionality</li>
    <li><strong>Validate markdown conversion</strong> quality from HTML</li>
  </ol>

  <h3 style="color: #ffc107; margin-top: 25px;">Additional Resources</h3>

  <p>At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis praesentium voluptatum deleniti atque corrupti quos dolores et quas molestias excepturi sint occaecati cupiditate non provident.</p>

  <p>Visit our website: <a href="https://bike4mind.com" style="color: #007bff; text-decoration: none;">Bike4Mind</a> | <a href="https://example.com" style="color: #007bff; text-decoration: none;">Documentation</a></p>

  <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">

  <p style="font-size: 12px; color: #888; text-align: center;">
    <small>Test timestamp: {{TIMESTAMP}}<br>
    This is an automated test email for Lambda ingestion validation.<br>
    © 2025 Test Automation System. All rights reserved.</small>
  </p>

  <p style="font-size: 11px; color: #aaa; text-align: center;">
    <a href="#" style="color: #aaa;">Unsubscribe</a> | <a href="#" style="color: #aaa;">Update Preferences</a>
  </p>
</body>
</html>
`,
  },
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a unique test ID
 */
function generateTestId(): string {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Get email content based on CLI flags
 */
function getEmailContent(from: string, to: string): string {
  const timestamp = generateTestId();
  const date = new Date().toUTCString();

  // Custom template from file
  if (argv.template) {
    const filePath = path.resolve(argv.template);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Template file not found: ${filePath}`);
    }
    console.log(`📄 Loading custom template: ${filePath}`);
    return fs.readFileSync(filePath, 'utf-8');
  }

  // Built-in templates
  let templateKey: keyof typeof EMAIL_TEMPLATES;
  let templateName: string;

  if (argv.html) {
    templateKey = 'html';
    templateName = EMAIL_TEMPLATES.html.name;
  } else if (argv.attachment) {
    templateKey = 'attachment';
    templateName = EMAIL_TEMPLATES.attachment.name;
  } else if (argv.newsletter) {
    templateKey = 'newsletter';
    templateName = EMAIL_TEMPLATES.newsletter.name;
  } else {
    // Default: simple template (or --quick flag)
    templateKey = 'simple';
    templateName = EMAIL_TEMPLATES.simple.name;
  }

  console.log(`📝 Using template: ${templateName}`);

  const template = EMAIL_TEMPLATES[templateKey].content;
  return template
    .replace(/{{FROM}}/g, from)
    .replace(/{{TO}}/g, to)
    .replace(/{{TIMESTAMP}}/g, timestamp)
    .replace(/{{DATE}}/g, date);
}

/**
 * Upload email to S3
 */
async function uploadToS3(emailContent: string): Promise<{ s3Key: string; size: number }> {
  const spinner = ora('Uploading test email to S3...').start();

  try {
    const s3Client = new S3Client({ region: AWS_REGION });
    const testId = generateTestId();
    const s3Key = `raw-emails/test-lambda-${testId}.eml`;
    const bucketName = Resource.emailIngestionBucket.name;
    const emailSize = Buffer.byteLength(emailContent, 'utf-8');

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      Body: Buffer.from(emailContent, 'utf-8'),
      ContentType: 'message/rfc822',
    });

    await s3Client.send(command);

    spinner.succeed(`Email uploaded to S3: s3://${bucketName}/${s3Key}`);

    if (argv.verbose) {
      console.log(`   Bucket: ${bucketName}`);
      console.log(`   Key: ${s3Key}`);
      console.log(`   Size: ${emailSize} bytes`);
    }

    return { s3Key, size: emailSize };
  } catch (error) {
    spinner.fail('Failed to upload email to S3');
    throw error;
  }
}

/**
 * Create S3 event notification message for SQS
 */
function createS3EventMessage(s3Key: string, emailSize: number): Record<string, unknown> {
  const bucketName = Resource.emailIngestionBucket.name;

  // S3 event notification structure (this gets sent as SQS message body)
  const s3Event = {
    Records: [
      {
        eventVersion: '2.1',
        eventSource: 'aws:s3',
        awsRegion: AWS_REGION,
        eventTime: new Date().toISOString(),
        eventName: 'ObjectCreated:Put',
        s3: {
          s3SchemaVersion: '1.0',
          configurationId: 'test-script-trigger',
          bucket: {
            name: bucketName,
            arn: `arn:aws:s3:::${bucketName}`,
          },
          object: {
            key: s3Key,
            size: emailSize,
          },
        },
      },
    ],
  };

  return s3Event;
}

/**
 * Send S3 event notification to SQS queue (triggers Lambda automatically)
 */
async function sendToQueue(s3Key: string, emailSize: number): Promise<void> {
  const spinner = ora('Sending message to email ingestion queue...').start();

  try {
    const sqsClient = new SQSClient({ region: AWS_REGION });
    const queueUrl = Resource.emailIngestionQueue.url;

    if (!queueUrl) {
      throw new Error('Email ingestion queue URL not found. Make sure SST resources are linked.');
    }

    // Create S3 event notification message
    const s3Event = createS3EventMessage(s3Key, emailSize);
    const messageBody = JSON.stringify(s3Event);

    if (argv.verbose) {
      console.log('\n📦 S3 Event Message:');
      console.log(JSON.stringify(s3Event, null, 2));
      console.log('');
    }

    // Send message to SQS queue
    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: messageBody,
    });

    const response = await sqsClient.send(command);

    spinner.succeed('Message sent to queue successfully');
    if (argv.verbose) {
      console.log(`   Queue URL: ${queueUrl}`);
      console.log(`   Message ID: ${response.MessageId}`);
    }
  } catch (error) {
    spinner.fail('Failed to send message to queue');
    throw error;
  }
}

/**
 * Delete test email from S3 (cleanup)
 */
async function cleanupS3(s3Key: string): Promise<void> {
  if (!argv.cleanup) {
    return;
  }

  const spinner = ora('Cleaning up test email from S3...').start();

  try {
    const s3Client = new S3Client({ region: AWS_REGION });
    const bucketName = Resource.emailIngestionBucket.name;

    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    });

    await s3Client.send(command);

    spinner.succeed('Test email deleted from S3');
  } catch (error) {
    spinner.warn('Failed to cleanup test email from S3 (non-fatal)');
    if (argv.verbose) {
      console.error(error);
    }
  }
}

// ============================================================================
// Main Function
// ============================================================================

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║         Email Ingest Lambda Test Script                  ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  console.log('📧 Test Configuration:');
  console.log(`   From: ${argv.from}`);
  console.log(`   To: ${argv.to}`);
  console.log(`   Cleanup: ${argv.cleanup ? 'Yes' : 'No'}`);
  console.log('');

  try {
    // 1. Get email content
    const emailContent = getEmailContent(argv.from, argv.to);

    // 2. Upload to S3
    const { s3Key, size } = await uploadToS3(emailContent);

    // 3. Send message to SQS queue (triggers Lambda automatically)
    await sendToQueue(s3Key, size);

    // 4. Cleanup (if requested)
    await cleanupS3(s3Key);

    // Success summary
    console.log('\n✅ Email ingestion flow triggered successfully!\n');
    console.log('📋 Next Steps:');
    console.log('   1. Check CloudWatch Logs for Lambda execution');
    console.log('   2. Verify email was ingested in MongoDB (ingestedEmails collection)');
    console.log('   3. Check if AI analysis was triggered (emailAnalysisQueue)');
    console.log('');

    if (!argv.cleanup) {
      console.log('💡 Tip: Use --cleanup flag to auto-delete test emails from S3');
      console.log(`   (Current test email: ${s3Key})\n`);
    }
  } catch (error) {
    console.error('\n❌ Error:', error instanceof Error ? error.message : error);
    if (argv.verbose && error instanceof Error) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main().catch(console.error);

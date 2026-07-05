# Email Ingestion Service

Vendor-agnostic email processing service for ingesting emails into the Bike4Mind platform. This service handles sender validation, email storage, attachment processing, and body conversion with full multi-tenant support.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
  - [Flow Diagram](#flow-diagram)
  - [Service Components](#service-components)
- [Integration Guide](#integration-guide)
  - [Step 1: Install Dependencies](#step-1-install-dependencies)
  - [Step 2: Database Setup](#step-2-database-setup)
  - [Step 3: Implement Email Parser Adapter](#step-3-implement-email-parser-adapter)
  - [Step 4: Implement Storage Adapter](#step-4-implement-storage-adapter)
  - [Step 5: Implement Queue Adapter (Optional)](#step-5-implement-queue-adapter-optional---for-ai-analysis)
  - [Step 6: Create Lambda Handler](#step-6-create-lambdacloud-function-handler)
- [Configuration Requirements](#configuration-requirements)
  - [Environment Variables](#environment-variables)
  - [AWS Infrastructure](#aws-infrastructure-example)
  - [Admin Settings Configuration](#admin-settings-configuration)
- [Adapter Implementation](#adapter-implementation)
  - [Custom Email Parser](#custom-email-parser)
  - [Custom Storage Adapter](#custom-storage-adapter)
  - [Custom Queue Adapter](#custom-queue-adapter)
- [Complete Examples](#complete-examples)
- [Error Handling](#error-handling)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
  - [AI Analysis Not Running](#ai-analysis-not-running)
  - [High AI Analysis Costs](#high-ai-analysis-costs)
  - [Prompt Injection Detected](#prompt-injection-detected)
- [API Reference](#api-reference)

---

## Overview

The Email Ingestion Service provides a complete solution for processing incoming emails:

- **Sender Validation**: Checks if the sender is authorized to send to a user's platform email
- **Email Storage**: Stores email metadata in MongoDB with threading support
- **Attachment Processing**: Uploads email attachments to fabFiles service
- **Body Conversion**: Converts HTML emails to clean markdown
- **Content Analysis**: Determines if email body warrants a fabFile creation
- **AI Analysis**: Optional LLM-powered email analysis with entity extraction, sentiment analysis, and privacy recommendations
- **Idempotency**: Safe retry handling for infrastructure failures

### Key Features

✅ **Vendor-agnostic**: Works with any email provider (AWS SES, SendGrid, Mailgun, etc.)
✅ **Parser-agnostic**: Supports mailparser, nodemailer, or custom parsers
✅ **Storage-agnostic**: Works with S3, GCS, Azure Blob, or local storage
✅ **Queue-agnostic**: Optional async AI analysis via SQS, PubSub, or custom queues
✅ **Dependency injection**: All external dependencies injected via adapters
✅ **Type-safe**: Full TypeScript support with strict typing
✅ **Testable**: Easy to mock adapters for unit testing
✅ **Cost-aware**: Tracks LLM token usage and cost per email analysis

---

## Architecture

### Flow Diagram

```
┌─────────────────┐
│ Email Provider  │  (AWS SES, SendGrid, etc.)
│  (SES/SMTP)     │
└────────┬────────┘
         │ Raw Email
         ↓
┌─────────────────┐
│ Storage Layer   │  (S3, GCS, Local, etc.)
│  (Raw Email)    │
└────────┬────────┘
         │ Trigger (SQS, PubSub, Webhook)
         ↓
┌──────────────────────────────────────────────┐
│      Email Parser Lambda/Function            │
│                                              │
│  1. Download raw email from storage          │
│  2. Parse with email parser adapter          │
│  3. Call processIngestedEmail()  ◄────────── │ @bike4mind/services
│     - Validate sender                        │
│     - Store email                            │
│     - Process attachments → fabFiles         │
│     - Process body → fabFile (if substantial)│
│     - Trigger AI analysis queue (optional)   │
└──────────────────┬───────────────────────────┘
                   │
                   ↓
┌─────────────────┐
│    MongoDB      │  IngestedEmailModel
│   (Email Data)  │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│   fabFiles      │  Attachments + Body
│  (S3 Storage)   │
└─────────────────┘

         ┌──────────────────────────────────┐
         │ Optional: AI Analysis Pipeline   │
         └──────────────────────────────────┘
                   │
                   ↓
         ┌─────────────────┐
         │ Analysis Queue  │  (SQS, PubSub)
         │ {emailId}       │
         └────────┬────────┘
                  │ Trigger
                  ↓
         ┌──────────────────────────────────────────┐
         │   Email Analyzer Lambda/Function         │
         │                                          │
         │  1. Fetch email from MongoDB             │
         │  2. Call analyzeEmail()  ◄────────────── │ @bike4mind/services
         │     - Extract entities                   │
         │     - Analyze sentiment                  │
         │     - Detect privacy level               │
         │     - Find action items                  │
         │     - Calculate cost                     │
         │  3. Update email.aiAnalysis in MongoDB   │
         └──────────────────────────────────────────┘
                  │
                  ↓
         ┌─────────────────┐
         │    MongoDB      │  IngestedEmailModel.aiAnalysis
         │ (Analysis Data) │  - summary, entities, sentiment
         └─────────────────┘  - tokensUsed, costUSD
```

### Service Components

#### Email Ingestion Service
1. **`processIngestedEmail`** - Main orchestration function
2. **`validateSenderAuthorization`** - Checks if sender is authorized
3. **`processAttachments`** - Handles email attachments
4. **`processEmailBody`** - Converts and stores email body
5. **`extractPlatformEmail`**, **`extractSenderEmail`**, **`extractEmails`** - Email parsing utilities

#### Email Analysis Service (Optional)
1. **`analyzeEmail`** - AI-powered email analysis with Claude/GPT
2. **Template Engine** - Meta-prompt system with variable substitution
3. **Security Layer** - Prompt injection protection with Unicode normalization
4. **Cost Tracking** - Token usage and cost calculation per analysis

---

## Integration Guide

### Step 1: Install Dependencies

```bash
cd your-app
pnpm add @bike4mind/services @bike4mind/common @bike4mind/utils
pnpm add mailparser  # or your preferred email parser
```

### Step 2: Database Setup

Ensure you have the required MongoDB models and indexes:

#### User Model Fields

Add these fields to your User model:

```typescript
interface IUser {
  // ... existing fields
  platformEmailAddress?: string;  // e.g., "john@app.bike4mind.com"
  authorizedEmailAddresses?: string[];  // e.g., ["john@gmail.com", "john@work.com"]
}
```

**MongoDB Index:**
```javascript
db.users.createIndex(
  { platformEmailAddress: 1 },
  { unique: true, sparse: true }
);
```

#### IngestedEmail Model

This model is defined in `@bike4mind/common`:

```typescript
import { IngestedEmailModel } from '@bike4mind/database';
```

**Required Indexes:**
```javascript
db.ingestedemails.createIndex({ messageId: 1 }, { unique: true });
db.ingestedemails.createIndex({ userId: 1, receivedAt: -1 });
db.ingestedemails.createIndex({ threadId: 1 });
```

### Step 3: Implement Email Parser Adapter

Create an adapter for your chosen email parser:

**Example with mailparser:**

```typescript
import { simpleParser, ParsedMail } from 'mailparser';
import { IEmailParserAdapter, ParsedEmailObject } from '@bike4mind/services/emailIngestionService';

export class MailparserAdapter implements IEmailParserAdapter {
  async parse(rawEmail: Buffer): Promise<ParsedEmailObject> {
    const parsed: ParsedMail = await simpleParser(rawEmail);

    return {
      messageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      subject: parsed.subject,
      date: parsed.date,
      text: parsed.text,
      html: parsed.html,
      attachments: parsed.attachments,
    };
  }
}
```

### Step 4: Implement Storage Adapter

Create an adapter for your storage system:

**Example with AWS S3:**

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { IStorageAdapter } from '@bike4mind/services/emailIngestionService';

export class S3StorageAdapter implements IStorageAdapter {
  constructor(private s3Client: S3Client, private bucketName: string) {}

  async upload(
    filepath: string,
    content: string | Buffer,
    options?: { ContentType?: string; ContentLength?: number }
  ): Promise<string> {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: filepath,
        Body: content,
        ContentType: options?.ContentType,
        ContentLength: options?.ContentLength,
      })
    );
    return `s3://${this.bucketName}/${filepath}`;
  }

  async generateSignedUrl(
    filepath: string,
    expireInSeconds: number,
    type: 'get' | 'put' = 'get'
  ): Promise<string> {
    const command = type === 'get'
      ? new GetObjectCommand({ Bucket: this.bucketName, Key: filepath })
      : new PutObjectCommand({ Bucket: this.bucketName, Key: filepath });

    return getSignedUrl(this.s3Client, command, { expiresIn: expireInSeconds });
  }
}
```

### Step 5: Implement Queue Adapter (Optional - for AI Analysis)

Create an adapter for your queue system to trigger AI analysis:

**Example with AWS SQS:**

```typescript
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { IQueueAdapter } from '@bike4mind/services/emailIngestionService';

export class SQSQueueAdapter implements IQueueAdapter {
  constructor(private sqsClient: SQSClient, private queueUrl: string) {}

  async sendMessage(message: Record<string, unknown>): Promise<string> {
    const result = await this.sqsClient.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
      })
    );
    return result.MessageId || 'sent';
  }
}
```

**Example with Google Cloud PubSub:**

```typescript
import { PubSub } from '@google-cloud/pubsub';
import { IQueueAdapter } from '@bike4mind/services/emailIngestionService';

export class PubSubQueueAdapter implements IQueueAdapter {
  constructor(private pubsub: PubSub, private topicName: string) {}

  async sendMessage(message: Record<string, unknown>): Promise<string> {
    const topic = this.pubsub.topic(this.topicName);
    const messageId = await topic.publishMessage({
      json: message
    });
    return messageId;
  }
}
```

**Note**: If you don't provide a queue adapter, AI analysis will be skipped.

### Step 6: Create Lambda/Cloud Function Handler

```typescript
import { SQSEvent, SQSHandler, S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { connectDB } from '@bike4mind/database';
import {
  userRepository,
  ingestedEmailRepository,
  fabFileRepository,
  adminSettingsRepository
} from '@bike4mind/database';
import { processIngestedEmail } from '@bike4mind/services/emailIngestionService';
import { MailparserAdapter } from './adapters/mailparser';
import { S3StorageAdapter } from './adapters/s3storage';

const s3Client = new S3Client({ region: process.env.AWS_REGION });
const sqsClient = new SQSClient({ region: process.env.AWS_REGION });
const emailParser = new MailparserAdapter();
const storageAdapter = new S3StorageAdapter(s3Client, process.env.FILES_BUCKET!);
const queueAdapter = new SQSQueueAdapter(sqsClient, process.env.ANALYSIS_QUEUE_URL!);

export const handler: SQSHandler = async (event: SQSEvent) => {
  // Connect to MongoDB
  await connectDB(process.env.MONGODB_URI!);

  for (const record of event.Records) {
    // Parse S3 event from SQS
    const s3Event: S3Event = JSON.parse(record.body);

    for (const s3Record of s3Event.Records) {
      const bucket = s3Record.s3.bucket.name;
      const key = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, ' '));

      // Download raw email from S3
      const response = await s3Client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key })
      );
      const rawEmail = await streamToBuffer(response.Body);

      // Parse email
      const parsedEmail = await emailParser.parse(rawEmail);

      // Process email with service (includes AI analysis trigger if queue provided)
      const result = await processIngestedEmail(
        parsedEmail,
        key, // S3 key as storage reference
        {
          db: {
            users: userRepository,
            ingestedEmails: ingestedEmailRepository,
            fabFiles: fabFileRepository,
            adminSettings: adminSettingsRepository,
          },
          storage: storageAdapter,
          queue: queueAdapter, // Optional: triggers AI analysis
        },
        {
          platformDomain: '@app.bike4mind.com', // optional: defaults to this
          isNewsletter: false,
        }
      );

      console.log('Email processed:', result);
    }
  }
};

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
```

---

## Configuration Requirements

### Environment Variables

```bash
# MongoDB
MONGODB_URI=mongodb://localhost:27017/bike4mind

# AWS (if using AWS)
AWS_REGION=us-east-2
FILES_BUCKET=your-fabfiles-bucket
RAW_EMAILS_BUCKET=your-raw-emails-bucket

# Email Platform
PLATFORM_EMAIL_DOMAIN=@app.bike4mind.com

# AI Analysis (Optional)
ANALYSIS_QUEUE_URL=https://sqs.us-east-2.amazonaws.com/123456789/email-analysis-queue
```

### AWS Infrastructure (Example)

If using AWS SES + S3 + Lambda:

**Email Ingestion:**
1. **SES Receipt Rule**: Route emails to S3 bucket
2. **S3 Bucket**: Store raw emails (30-day lifecycle)
3. **SQS Queue** (emailIngestionQueue): Receive S3 notifications
4. **Lambda Function** (emailParser): Process emails from SQS

**AI Analysis (Optional):**
5. **SQS Queue** (emailAnalysisQueue): Receive emailId messages after ingestion
6. **Lambda Function** (emailAnalyzer): Perform AI analysis from SQS

See `examples/aws-lambda-example.ts` for complete AWS setup.

### Admin Settings Configuration

Configure AI analysis behavior via MongoDB AdminSettings collection:

```typescript
// AdminSettings keys (defined in @bike4mind/common)
{
  EnableEmailAnalysis: true,              // Enable/disable AI analysis
  EmailAnalysisModel: 'claude-3-5-sonnet-20241022-bedrock', // LLM model
  EmailAnalysisTemperature: 0.3,          // LLM temperature (0-1)
  EmailAnalysisPrompt: 'custom prompt',   // Optional custom meta-prompt
  MaxDailyEmailAnalyses: 100              // Rate limit per user per day
}
```

**Default Values:**
- Analysis is **enabled** by default
- Uses **Claude 3.5 Sonnet** via Bedrock
- Temperature: **0.3** (focused, consistent analysis)
- Max daily analyses: **100** per user
- Default meta-prompt: Extracts entities, sentiment, privacy level, action items

**Rate Limiting:**
The system enforces `MaxDailyEmailAnalyses` per user in a rolling 24-hour window to prevent cost overruns. When limit is reached, analysis is skipped (email is still ingested).

---

## Adapter Implementation

### Custom Email Parser

If you're not using mailparser, implement the `IEmailParserAdapter`:

```typescript
import { IEmailParserAdapter, ParsedEmailObject } from '@bike4mind/services/emailIngestionService';

export class CustomEmailParser implements IEmailParserAdapter {
  async parse(rawEmail: Buffer): Promise<ParsedEmailObject> {
    // Your custom parsing logic
    const parsed = await yourParsingLibrary.parse(rawEmail);

    // Map to ParsedEmailObject interface
    return {
      messageId: parsed.id,
      from: { value: [{ address: parsed.sender.email }], text: parsed.sender.name },
      to: { value: [{ address: parsed.recipient.email }], text: parsed.recipient.name },
      subject: parsed.title,
      date: new Date(parsed.timestamp),
      text: parsed.plainBody,
      html: parsed.htmlBody,
      attachments: parsed.files.map(f => ({
        filename: f.name,
        contentType: f.mime,
        size: f.bytes,
        content: f.buffer,
        contentDisposition: f.inline ? 'inline' : 'attachment',
      })),
    };
  }
}
```

### Custom Storage Adapter

For non-S3 storage (GCS, Azure, local):

```typescript
import { IStorageAdapter } from '@bike4mind/services/emailIngestionService';

export class LocalStorageAdapter implements IStorageAdapter {
  constructor(private basePath: string) {}

  async upload(
    filepath: string,
    content: string | Buffer,
    options?: { ContentType?: string }
  ): Promise<string> {
    const fullPath = path.join(this.basePath, filepath);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, content);
    return `file://${fullPath}`;
  }

  async generateSignedUrl(filepath: string, expireInSeconds: number): Promise<string> {
    // For local storage, just return file path or use a token-based URL
    return `http://localhost:3000/files/${filepath}?expires=${Date.now() + expireInSeconds * 1000}`;
  }
}
```

### Custom Queue Adapter

For non-SQS queues (Google PubSub, RabbitMQ, etc.):

```typescript
import { IQueueAdapter } from '@bike4mind/services/emailIngestionService';

export class CustomQueueAdapter implements IQueueAdapter {
  async sendMessage(message: Record<string, unknown>): Promise<string> {
    // Your queue implementation
    // For AI analysis, message will contain: { emailId: string }

    await yourQueue.publish({
      topic: 'email-analysis',
      data: message
    });

    return 'message-id';
  }
}
```

---

## Complete Examples

### Example 1: Basic Integration (Lumina5)

See `/examples/aws-lambda-example.ts` for a complete working example using AWS SES, S3, and Lambda.

### Example 2: Google Cloud Platform

```typescript
import { Storage } from '@google-cloud/storage';
import { processIngestedEmail } from '@bike4mind/services/emailIngestionService';

const storage = new Storage();
const bucket = storage.bucket('your-raw-emails-bucket');

export async function handlePubSubMessage(message: any) {
  // Download email from GCS
  const file = bucket.file(message.attributes.objectId);
  const [contents] = await file.download();

  // Parse and process
  const parsedEmail = await emailParser.parse(contents);

  const result = await processIngestedEmail(
    parsedEmail,
    message.attributes.objectId,
    adapters
  );

  console.log('Processed:', result.emailId);
}
```

### Example 3: With Error Handling and Bounce Notifications

```typescript
try {
  const result = await processIngestedEmail(parsedEmail, s3Key, adapters);
  console.log('✅ Email processed:', result.emailId);
} catch (error) {
  if (error.message === 'Unauthorized sender or invalid platform email') {
    // Send bounce notification
    await sesClient.send(
      new SendEmailCommand({
        Source: 'noreply@app.bike4mind.com',
        Destination: { ToAddresses: [senderEmail] },
        Message: {
          Subject: { Data: 'Email Delivery Failure' },
          Body: {
            Text: {
              Data: 'Your email was not delivered because you are not authorized to send to this address.',
            },
          },
        },
      })
    );
  }
  throw error; // Re-throw for DLQ handling
}
```

### Example 4: AI Analysis Lambda Handler

```typescript
import { SQSEvent, SQSHandler } from 'aws-lambda';
import { connectDB, IngestedEmailModel } from '@bike4mind/database';
import { analyzeEmail } from '@bike4mind/services/emailAnalysisService';
import { adminSettingsRepository } from '@bike4mind/database';
import { createBedrockBackend } from '@bike4mind/utils';

export const handler: SQSHandler = async (event: SQSEvent) => {
  await connectDB(process.env.MONGODB_URI!);

  for (const record of event.Records) {
    const { emailId } = JSON.parse(record.body);

    // Fetch email from MongoDB
    const email = await IngestedEmailModel.findById(emailId);
    if (!email || email.aiAnalysis?.summary) {
      continue; // Skip if already analyzed
    }

    // Check rate limit
    const dailyCount = await IngestedEmailModel.countDocuments({
      userId: email.userId,
      'aiAnalysis.analyzedAt': { $gte: new Date(Date.now() - 86400000) }
    });
    const maxDaily = (await adminSettingsRepository.get('MaxDailyEmailAnalyses')) || 100;
    if (dailyCount >= maxDaily) {
      console.log('Rate limit reached for user:', email.userId);
      continue;
    }

    // Get analysis config from AdminSettings
    const model = await adminSettingsRepository.get('EmailAnalysisModel');
    const temperature = await adminSettingsRepository.get('EmailAnalysisTemperature');
    const customPrompt = await adminSettingsRepository.get('EmailAnalysisPrompt');

    // Perform AI analysis
    const analysis = await analyzeEmail(
      {
        subject: email.subject,
        from: email.from,
        bodyMarkdown: email.bodyMarkdown,
        attachments: email.attachments
      },
      {
        llm: {
          backend: createBedrockBackend(),
          model: model || 'claude-3-5-sonnet-20241022-bedrock'
        },
        db: { adminSettings: adminSettingsRepository }
      },
      {
        temperature: temperature || 0.3,
        metaPrompt: customPrompt
      }
    );

    // Calculate cost (example for Claude 3.5 Sonnet)
    const costUSD =
      (analysis.tokensUsed.input / 1_000_000) * 3.0 +
      (analysis.tokensUsed.output / 1_000_000) * 15.0;

    // Update email with analysis
    await IngestedEmailModel.findByIdAndUpdate(emailId, {
      aiAnalysis: {
        ...analysis,
        analyzedAt: new Date(),
        model: model || 'claude-3-5-sonnet-20241022-bedrock',
        costUSD
      }
    });

    console.log('✅ Email analyzed:', emailId, 'Cost:', costUSD.toFixed(4));
  }
};
```

---

## Error Handling

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Unauthorized sender or invalid platform email` | Sender not in `authorizedEmailAddresses` | Add sender to user's authorized list |
| `User not found` | Platform email doesn't match any user | Check `platformEmailAddress` in user collection |
| `File type not supported` | Attachment MIME type not allowed | Check `SupportedFabFileMimeTypes` in common package |
| `Email already exists` | Duplicate messageId | Safe to ignore - idempotent operation |
| `Rate limit reached` | User exceeded `MaxDailyEmailAnalyses` | Wait 24 hours or increase limit in AdminSettings |
| `LLM API error` | Bedrock/OpenAI API failure | Check API credentials, quotas, and model availability |

### Retry Strategy

The service is designed for safe retries:

- **Idempotency**: Duplicate emails are detected by `messageId`
- **Partial Processing**: If attachments/body are already processed, they're skipped
- **DLQ Handling**: After 3-5 retries, send to Dead Letter Queue for manual review

---

## Testing

### Unit Test Example

```typescript
import { processIngestedEmail } from '@bike4mind/services/emailIngestionService';
import { vi, describe, it, expect } from 'vitest';

describe('processIngestedEmail', () => {
  it('should process email successfully', async () => {
    // Mock adapters
    const mockAdapters = {
      db: {
        users: {
          findOne: vi.fn().mockResolvedValue({
            id: 'user123',
            platformEmailAddress: 'john@app.bike4mind.com',
            authorizedEmailAddresses: ['john@gmail.com'],
          }),
        },
        ingestedEmails: {
          findByMessageId: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'email123' }),
          findById: vi.fn().mockResolvedValue({ id: 'email123', attachments: [] }),
          update: vi.fn().mockResolvedValue({}),
        },
        fabFiles: {
          create: vi.fn().mockResolvedValue({ id: 'file123' }),
        },
        adminSettings: {
          findAll: vi.fn().mockResolvedValue([]),
        },
      },
      storage: {
        upload: vi.fn().mockResolvedValue('s3://bucket/file'),
        generateSignedUrl: vi.fn().mockResolvedValue('https://signed-url'),
      },
    };

    const parsedEmail = {
      messageId: 'msg123',
      from: { value: [{ address: 'john@gmail.com' }] },
      to: { value: [{ address: 'john@app.bike4mind.com' }] },
      subject: 'Test Email',
      text: 'Hello world',
      date: new Date(),
    };

    const result = await processIngestedEmail(
      parsedEmail,
      's3-key-123',
      mockAdapters
    );

    expect(result.emailId).toBe('email123');
    expect(mockAdapters.db.ingestedEmails.create).toHaveBeenCalled();
  });
});
```

---

## Troubleshooting

### Email Not Being Ingested

1. Check CloudWatch/logs for Lambda errors
2. Verify S3 bucket permissions for Lambda
3. Check MongoDB connection string
4. Verify user has `platformEmailAddress` set
5. Verify sender is in `authorizedEmailAddresses`

### Attachments Not Uploading

1. Check fabFiles bucket permissions
2. Verify attachment MIME type is supported
3. Check attachment size limits (default 20MB)
4. Look for storage adapter errors in logs

### Body Not Converting to Markdown

1. Check if email body meets substantial content threshold (500 chars text / 2000 chars HTML)
2. Verify turndown library is installed
3. Check for HTML parsing errors in logs

### Performance Issues

1. **Lambda Timeout**: Increase timeout to 5 minutes for large emails
2. **Memory**: Increase Lambda memory to 1024MB for attachment processing
3. **Concurrent Emails**: Use SQS batch size of 1-5 to avoid overload

### AI Analysis Not Running

1. Check if `EnableEmailAnalysis` is `true` in AdminSettings
2. Verify queue adapter is provided to `processIngestedEmail`
3. Check emailAnalysisQueue for messages in DLQ
4. Verify user hasn't hit daily rate limit (`MaxDailyEmailAnalyses`)
5. Check Lambda permissions for Bedrock API access

### High AI Analysis Costs

1. Lower `MaxDailyEmailAnalyses` to reduce per-user limits
2. Use a cheaper model (e.g., Claude Haiku instead of Sonnet)
3. Monitor `IngestedEmailModel.aiAnalysis.costUSD` field
4. Set up CloudWatch alerts for cost thresholds
5. Consider disabling analysis for newsletters: `isNewsletter: true`

### Prompt Injection Detected

The system automatically filters common prompt injection patterns:
- Check logs for `[FILTERED]` markers in email content
- Review `IngestedEmailModel.aiAnalysis` for unexpected results
- If false positives occur, adjust sanitization rules in `templateEngine.ts`
- Unicode homoglyph attacks (e.g., fullwidth chars) are normalized via NFKD

---

## API Reference

### Email Ingestion Service

#### `processIngestedEmail(parsedEmail, rawEmailS3Key, adapters, options?)`

**Parameters:**
- `parsedEmail: ParsedEmailObject` - Parsed email object
- `rawEmailS3Key: string` - Storage reference for raw email
- `adapters: EmailIngestionAdapters` - Database, storage, and queue adapters
- `options?: { platformDomain?: string; isNewsletter?: boolean }` - Optional configuration

**Adapters Interface:**
```typescript
interface EmailIngestionAdapters {
  db: {
    users: IUserRepository;
    ingestedEmails: IIngestedEmailRepository;
    fabFiles: IFabFileRepository;
    adminSettings: IAdminSettingsRepository;
  };
  storage: IStorageAdapter;
  queue?: IQueueAdapter; // Optional: triggers AI analysis if provided
}
```

**Returns:** `Promise<IngestedEmailResult>`

**Throws:**
- `Error('Unauthorized sender or invalid platform email')` - If sender validation fails

### Email Analysis Service

#### `analyzeEmail(email, adapters, options?)`

**Parameters:**
- `email: EmailAnalysisInput` - Email content to analyze
- `adapters: EmailAnalysisAdapters` - LLM backend and database adapters
- `options?: EmailAnalysisOptions` - Temperature, custom prompt, etc.

**Input Interface:**
```typescript
interface EmailAnalysisInput {
  subject?: string;
  from?: string;
  bodyMarkdown?: string;
  bodyText?: string;
  attachments?: Array<{ filename: string; contentType: string }>;
}
```

**Adapters Interface:**
```typescript
interface EmailAnalysisAdapters {
  llm: {
    backend: ILLMBackend; // Bedrock, OpenAI, etc.
    model: string;
  };
  db: {
    adminSettings: IAdminSettingsRepository;
  };
}
```

**Options Interface:**
```typescript
interface EmailAnalysisOptions {
  temperature?: number; // 0-1, default 0.3
  metaPrompt?: string; // Custom analysis prompt template
}
```

**Returns:** `Promise<EmailAnalysisResult>`

```typescript
interface EmailAnalysisResult {
  summary: string;
  entities: {
    companies: string[];
    people: string[];
    products: string[];
    technologies: string[];
  };
  sentiment: 'positive' | 'neutral' | 'negative' | 'urgent';
  actionItems: Array<{ description: string; deadline?: Date }>;
  privacyRecommendation: 'public' | 'team' | 'private';
  embargoDetected: boolean;
  suggestedTags: string[];
  tokensUsed: {
    input: number;
    output: number;
  };
}
```

---

## Support

For questions or issues:
- File an issue in the repository
- Contact the B4M team
- See main `CLAUDE.md` for project guidelines

---

## License

Part of the Bike4Mind (@bike4mind) monorepo. See main LICENSE file.

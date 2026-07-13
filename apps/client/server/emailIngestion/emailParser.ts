import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SQSEvent, SQSHandler, SQSBatchItemFailure, S3Event } from 'aws-lambda';
import { simpleParser, ParsedMail } from 'mailparser';
import {
  userRepository,
  ingestedEmailRepository,
  fabFileRepository,
  adminSettingsRepository,
  connectDB,
} from '@bike4mind/database';
import { Resource } from 'sst';
// @ts-ignore - service may not be exported in types yet
import { emailIngestionService } from '@bike4mind/services';
import { UnauthorizedError } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { getFilesStorage } from '@server/utils/storage';
import { sendToQueue } from '@server/utils/sqs';

const { processIngestedEmail } = emailIngestionService;
type IEmailParserAdapter = emailIngestionService.IEmailParserAdapter;
type ParsedEmailObject = emailIngestionService.ParsedEmailObject;

/**
 * Email Parser Lambda Handler
 *
 * Processes incoming emails from the SQS queue:
 * 1. Receives S3 event notification from SQS
 * 2. Downloads raw email from S3
 * 3. Parses email with mailparser adapter
 * 4. Calls emailIngestionService to process email
 *
 * Flow: SES -> S3 -> S3 notification -> SQS -> Lambda
 */

/**
 * Mailparser adapter implementation
 */
class MailparserAdapter implements IEmailParserAdapter {
  async parse(rawEmail: Buffer): Promise<ParsedEmailObject> {
    const parsed: ParsedMail = await simpleParser(rawEmail);

    // Log diagnostic information after parsing
    Logger.info('Email parsed', {
      messageId: parsed.messageId,
      subject: parsed.subject,
      textLength: parsed.text?.length || 0,
      htmlLength: parsed.html ? String(parsed.html).length : 0,
      attachmentCount: parsed.attachments?.length || 0,
    });

    // Detect forwarded emails with empty body
    const isForwarded =
      parsed.subject?.toLowerCase().startsWith('fwd:') || parsed.subject?.toLowerCase().startsWith('fw:');

    if (isForwarded && !parsed.text && !parsed.html) {
      Logger.warn('Forwarded email with empty body detected', {
        subject: parsed.subject,
        messageId: parsed.messageId,
      });
    }

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
      html: parsed.html || undefined, // Convert false to undefined
      attachments: parsed.attachments.map(att => ({
        filename: att.filename,
        contentType: att.contentType,
        contentDisposition: att.contentDisposition,
        size: att.size,
        content: att.content,
        related: att.related, // Pass through the related flag
      })),
    };
  }
}

/**
 * Download raw email from S3
 */
async function downloadEmailFromS3(s3Client: S3Client, bucket: string, key: string): Promise<Buffer> {
  Logger.info(`Downloading email from s3://${bucket}/${key}`);

  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await s3Client.send(command);

  if (!response.Body) {
    throw new Error('Empty response body from S3');
  }

  // Convert stream to buffer
  const chunks: Uint8Array[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const chunk of response.Body as any) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * Storage adapter for fabFiles
 */
const storageAdapter = {
  upload: (filepath: string, content: string | Buffer, options?: { ContentType?: string; ContentLength?: number }) => {
    const payload = content ?? '';
    return getFilesStorage().upload(payload, filepath, {
      ContentType: options?.ContentType,
      ContentLength: options?.ContentLength ?? Buffer.byteLength(payload),
    });
  },
  generateSignedUrl: (filepath: string, expireInSeconds: number, type?: 'get' | 'put') =>
    getFilesStorage().getSignedUrl(filepath, type === 'put' ? 'put' : 'get', {
      expiresIn: expireInSeconds,
    }),
};

/**
 * Queue adapter for triggering AI analysis
 */
const queueAdapter = {
  sendMessage: async (message: Record<string, unknown>): Promise<string> => {
    // @ts-ignore - Resource.emailAnalysisQueue is defined in infra but not yet in sst-env.d.ts
    const queueUrl = Resource.emailAnalysisQueue?.url;
    if (!queueUrl) {
      Logger.warn('Email analysis queue not configured, skipping AI analysis trigger');
      return 'skipped';
    }
    const result = await sendToQueue(queueUrl, message);
    return result || 'sent';
  },
};

/**
 * Main handler
 */
const emailParser = new MailparserAdapter();

export const dispatch: SQSHandler = async (event: SQSEvent) => {
  Logger.info('🚀 EMAIL PARSER LAMBDA INVOKED');

  // Connect to MongoDB first - replace %STAGE% placeholder
  const mongoUri = Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage);
  Logger.info('📦 Environment:', {
    AWS_REGION: process.env.AWS_REGION,
    NODE_ENV: process.env.NODE_ENV,
    STAGE: Resource.App.stage,
    MONGODB_URI: mongoUri ? '✅ Set' : '❌ Missing',
  });

  Logger.info('🔌 Connecting to MongoDB...');
  await connectDB(mongoUri);
  Logger.info('✅ MongoDB connected');

  // Create S3 client on each invocation to ensure fresh AWS credentials.
  // Lambda containers can stay warm for extended periods (>15-60 min), causing
  // module-level clients to capture expired credentials. This pattern prevents
  // production failures: "InvalidSignatureException: Signature expired"
  const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

  Logger.info('📨 SQS Event Records Count:', event.Records.length);

  // Queue is subscribed with batch.partialResponses: true, so a per-record failure is
  // reported here instead of thrown, letting SQS retry/DLQ just that record instead of
  // the whole batch (which would also redeliver already-succeeded records).
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    Logger.info('🔄 Processing SQS Record:', record.messageId);
    try {
      // Parse SQS message body (S3 event notification)
      const body = JSON.parse(record.body);

      // Handle S3 test events gracefully (skip them)
      if (body.Event === 's3:TestEvent') {
        Logger.info('Received S3 test event, skipping...');
        continue;
      }

      // Handle SES test notification
      if (body.Service === 'Amazon S3' && body.Event === 's3:TestEvent') {
        Logger.info('Received S3/SES test notification, skipping...');
        continue;
      }

      // Validate it's an S3 event with Records
      if (!body.Records || !Array.isArray(body.Records)) {
        Logger.warn('Invalid S3 event format (no Records array), skipping...', body);
        continue;
      }

      const s3Event: S3Event = body;

      // Process each S3 record
      for (const s3Record of s3Event.Records) {
        const bucket = s3Record.s3.bucket.name;
        const key = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, ' '));

        Logger.info(`📧 Processing email from s3://${bucket}/${key}`);

        // Skip AWS setup notifications
        if (key.includes('AMAZON_SES_SETUP_NOTIFICATION')) {
          Logger.info('Skipping SES setup notification file');
          continue;
        }

        // 1. Download raw email from S3
        const rawEmail = await downloadEmailFromS3(s3Client, bucket, key);

        // 2. Parse email with mailparser adapter
        const parsedEmail = await emailParser.parse(rawEmail);

        // 3. Process email with service (includes AI analysis trigger via queue)
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
            queue: queueAdapter, // Triggers AI analysis after ingestion
          },
          {
            // Externalized for open-core: the inbound-email recipient domain
            // comes from PLATFORM_EMAIL_DOMAIN with no brand fallback. Empty == no email is
            // treated as a platform address (see extractPlatformEmail).
            platformDomain: process.env.PLATFORM_EMAIL_DOMAIN || '',
            isNewsletter: false,
          }
        );

        Logger.info('✅ Email processing complete', {
          emailId: result.emailId,
          messageId: result.messageId,
          threadId: result.threadId,
          attachments: result.attachments.length,
          bodyFabFile: result.bodyFabFileCreated ? 'created' : 'skipped',
          alreadyProcessed: result.alreadyProcessed,
        });
      }
    } catch (error) {
      Logger.error('❌ ERROR processing email:', error);
      Logger.error('❌ Error stack:', error instanceof Error ? error.stack : 'No stack trace');

      // Check if it's an authorization error
      if (error instanceof UnauthorizedError) {
        Logger.warn('Unauthorized email - consider sending bounce notification');
        // TODO: Implement bounce notification via SES SendEmail
        // Don't report as failed - we want to remove this from the queue
        continue;
      }

      // Report this record as failed so SQS retries/DLQs it; keep processing the rest.
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  Logger.info('🎉 Lambda execution complete - all records processed', {
    failedCount: batchItemFailures.length,
  });

  return { batchItemFailures };
};

// Export handler with both names for compatibility
export const handler = dispatch;

import { allSecrets } from './secrets';
import { websocketApi } from './websocket';
import { DEFAULT_LAMBDA_ENVIRONMENT, SINGLE_RECORD_BATCH } from './constants';
import { lambdaVpc } from './vpc';
import { fabFileBucket, generatedImagesBucket } from './buckets';

/**
 * ===============================
 * Email Ingestion Infrastructure
 * ===============================
 *
 * This module sets up the AWS infrastructure for the Email-to-Platform Ingestion feature:
 * - S3 bucket for storing raw incoming emails
 * - SQS queue for triggering email processing
 * - Lambda function for parsing and storing emails
 *
 * Architecture:
 * 1. User sends email to their platform address (e.g., user@app.example.com)
 * 2. AWS SES receives email → stores in S3 bucket
 * 3. S3 triggers SQS queue message
 * 4. Lambda function processes email:
 *    - Downloads from S3
 *    - Parses with mailparser
 *    - Validates sender against user's authorizedEmailAddresses
 *    - Stores in MongoDB (IngestedEmailModel)
 *    - Triggers AI analysis pipeline
 *
 * Related: packages/database/src/models/IngestedEmailModel.ts
 */

/**
 * S3 Bucket for Raw Email Storage
 *
 * Stores incoming emails in RFC 822 format as received from AWS SES.
 * Emails are encrypted at rest with SSE-S3.
 *
 * Lifecycle: Raw emails are retained for 30 days, then auto-deleted
 * (parsed data is already in MongoDB)
 */

// Get AWS account ID and region as Outputs
const awsAccountId = aws.getCallerIdentityOutput({}).accountId;
const awsRegion = aws.getRegionOutput().name;

// Create the SES ARN using $interpolate to handle Outputs correctly
const sesSourceArn = $interpolate`arn:aws:ses:${awsRegion}:${awsAccountId}:*`;

export const emailIngestionBucket = new sst.aws.Bucket('emailIngestionBucket', {
  versioning: false, // Not needed for raw emails
  policy: [
    {
      effect: 'allow',
      actions: ['s3:PutObject'],
      principals: [{ type: 'service', identifiers: ['ses.amazonaws.com'] }],
      conditions: [
        {
          test: 'StringEquals',
          variable: 'AWS:SourceAccount',
          values: [awsAccountId],
        },
        {
          test: 'StringLike',
          variable: 'AWS:SourceArn',
          values: [sesSourceArn],
        },
      ],
    },
  ],
});

/**
 * S3 Lifecycle Rule - Auto-delete Raw Emails After 30 Days
 *
 * Raw emails are only needed temporarily for parsing.
 * Parsed data is stored in MongoDB and can be retained indefinitely.
 */
const emailIngestionBucketLifecycle = new aws.s3.BucketLifecycleConfigurationV2('emailIngestionBucketLifecycle', {
  bucket: emailIngestionBucket.name,
  rules: [
    {
      id: 'delete-raw-emails-after-30-days',
      status: 'Enabled',
      filter: {
        prefix: 'raw-emails/',
      },
      expiration: {
        days: 30,
      },
    },
  ],
});

/**
 * SQS Queue for Email Processing
 *
 * Receives notifications from S3 when a new email arrives.
 * Lambda function polls this queue to process incoming emails.
 *
 * Visibility timeout: 5 minutes (gives Lambda time to parse and store email)
 * Message retention: 4 days (in case of processing failures)
 * Long polling: 20 seconds (reduces empty receive requests)
 */
const emailIngestionQueueDLQ = new sst.aws.Queue('emailIngestionQueueDLQ', {});

export const emailIngestionQueue = new sst.aws.Queue('emailIngestionQueue', {
  visibilityTimeout: '5 minutes',
  dlq: {
    queue: emailIngestionQueueDLQ.arn,
    retry: 3,
  },
});

/**
 * SQS Queue for Email AI Analysis
 *
 * Receives emailId messages from the email parser Lambda after successful ingestion.
 * Lambda function polls this queue to perform AI analysis on ingested emails.
 *
 * Visibility timeout: 3 minutes (gives Lambda time to call LLM and update database)
 * Message retention: 4 days (in case of processing failures)
 */
const emailAnalysisQueueDLQ = new sst.aws.Queue('emailAnalysisQueueDLQ', {});

export const emailAnalysisQueue = new sst.aws.Queue('emailAnalysisQueue', {
  visibilityTimeout: '3 minutes',
  dlq: {
    queue: emailAnalysisQueueDLQ.arn,
    retry: 3,
  },
});

/**
 * Lambda Function - Email Parser
 *
 * Processes incoming emails from the SQS queue:
 * 1. Downloads raw email from S3
 * 2. Parses email with mailparser (headers, body, attachments)
 * 3. Validates sender against user's authorizedEmailAddresses
 * 4. Stores parsed email in MongoDB (IngestedEmailModel)
 * 5. Triggers AI analysis pipeline via emailAnalysisQueue
 * 6. Deletes raw email from S3 (or marks as processed)
 *
 * Security:
 * - Only processes emails from authorized senders
 * - Rejects unauthorized emails with bounce notification
 * - Validates platform email address exists in UserModel
 *
 * Handler: apps/client/server/emailIngestion/emailParser.dispatch
 */
export const emailParserQueueSubscription = emailIngestionQueue.subscribe({
  handler: 'apps/client/server/emailIngestion/emailParser.dispatch',
  runtime: 'nodejs24.x',
  timeout: '5 minutes',
  memory: '512 MB',
  vpc: lambdaVpc,
  link: [
    ...allSecrets,
    emailIngestionBucket,
    emailIngestionQueue,
    emailAnalysisQueue,
    fabFileBucket,
    generatedImagesBucket,
    websocketApi,
  ],
  logging: {
    retention: '1 week',
  },
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  permissions: [
    {
      actions: ['bedrock:*'],
      resources: ['*'],
    },
    {
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    },
  ],
});

/**
 * SES Receipt Rule Set
 *
 * Creates a rule set for processing incoming emails.
 * Only created for production and dev stages to avoid conflicts.
 *
 * Note: Only ONE rule set can be active per region per AWS account.
 * For personal dev stages (erikbethke, etc.), use the Console to create rules manually,
 * or configure your own rule set that doesn't conflict with prod/dev.
 */
const sesRuleSetName = `${$app.name}-${$app.stage}-email-ingestion`;

const sesReceiptRuleSet =
  $app.stage === 'production' || $app.stage === 'dev'
    ? new aws.ses.ReceiptRuleSet('emailReceiptRuleSet', {
        ruleSetName: sesRuleSetName,
      })
    : undefined;

/**
 * SES Receipt Rule
 *
 * Routes incoming emails to S3:
 * - S3 Action: Store raw email in bucket
 * - S3 event notification (configured below) triggers SQS → Lambda
 *
 * Note: SES receipt rules do NOT support direct SQS actions.
 * We use S3 event notifications instead.
 *
 * Only created for production and dev stages.
 */
const sesReceiptRule = sesReceiptRuleSet
  ? new aws.ses.ReceiptRule(
      'emailReceiptRule',
      {
        ruleSetName: sesReceiptRuleSet.ruleSetName,
        name: `${$app.stage}-email-ingest`, // Shortened to stay under 32 char limit
        recipients: [], // Empty array = catch-all for verified domain
        enabled: true,
        scanEnabled: true, // Spam and virus scanning
        tlsPolicy: 'Optional',
        s3Actions: [
          {
            bucketName: emailIngestionBucket.name,
            objectKeyPrefix: 'raw-emails/',
            position: 1,
          },
        ],
      },
      {
        dependsOn: [emailIngestionBucket, sesReceiptRuleSet],
        replaceOnChanges: ['*'], // Force replacement on any changes instead of update
        deleteBeforeReplace: true, // Delete old rule before creating new one (SES rules have unique name constraints)
      }
    )
  : undefined;

/**
 * Activate the SES Rule Set
 *
 * Only ONE rule set can be active at a time per region.
 * This resource sets our rule set as the active one.
 */
const sesActiveRuleSet = sesReceiptRuleSet
  ? new aws.ses.ActiveReceiptRuleSet(
      'emailActiveRuleSet',
      {
        ruleSetName: sesReceiptRuleSet.ruleSetName,
      },
      {
        dependsOn: [sesReceiptRuleSet],
      }
    )
  : undefined;

/**
 * S3 Event Notification → Lambda via Queue
 *
 * When SES writes an email to S3, trigger the Lambda function via the SQS queue.
 * This is how we connect S3 to Lambda processing (since SES receipt rules
 * don't support direct SQS actions).
 *
 * Flow: SES → S3 → S3 notification → Lambda (with SQS queue subscription)
 *
 * Note: The Lambda function is already subscribed to the queue (emailParserQueueSubscription above),
 * so we just need to configure the S3 bucket to trigger on object creation.
 */
const emailIngestionBucketNotification = emailIngestionBucket.notify({
  notifications: [
    {
      name: 'emailReceived',
      queue: emailIngestionQueue.arn,
      events: ['s3:ObjectCreated:*'],
      filterPrefix: 'raw-emails/', // Only trigger for emails in this prefix
    },
  ],
});

/**
 * Lambda Function - Email AI Analyzer
 *
 * Performs AI analysis on ingested emails:
 * 1. Fetches email from MongoDB by emailId
 * 2. Calls emailAnalysisService.analyzeEmail() with Claude 3.5 Sonnet
 * 3. Extracts: summary, entities, sentiment, action items, privacy recommendation
 * 4. Updates IngestedEmailModel.aiAnalysis field
 * 5. Sends WebSocket notification to user
 *
 * Features:
 * - Idempotent: skips re-analysis if aiAnalysis already exists
 * - Uses existing LLM service layer from b4m-core
 * - Configurable via AdminSettings (model, temperature, custom prompt)
 * - DLQ retry on failures
 *
 * Handler: apps/client/server/emailIngestion/emailAnalyzer.dispatch
 */
const emailAnalyzerQueueSubscription = emailAnalysisQueue.subscribe(
  {
    handler: 'apps/client/server/emailIngestion/emailAnalyzer.dispatch',
    runtime: 'nodejs24.x',
    timeout: '2 minutes',
    memory: '512 MB',
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi, fabFileBucket, generatedImagesBucket],
    logging: {
      retention: '1 week',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      },
    ],
  },
  SINGLE_RECORD_BATCH
);

/**
 * Export resources for use in other infrastructure modules
 */
export {
  emailIngestionBucketLifecycle,
  emailIngestionQueueDLQ,
  emailAnalysisQueueDLQ,
  emailIngestionBucketNotification,
  sesReceiptRuleSet,
  sesReceiptRule,
  sesActiveRuleSet,
  emailAnalyzerQueueSubscription,
};

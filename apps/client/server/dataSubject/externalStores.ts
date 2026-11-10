import type { RetentionPeriod } from './types';
import { FINANCIAL_RECORD, SAFETY_INCIDENT } from './registry/retention';

/**
 * Where a person's data lands outside MongoDB, and what erasure does about each place. The Mongo side
 * is `DATA_HOLDER_REGISTRY` (`registry/index.ts`); this list completes the data map for the stores
 * the coverage test cannot walk. `externalStores.repo.test.ts` fails when an S3 bucket or event bus is
 * declared in `infra/` without an entry here, and when an `erasedBy` function is not exported.
 */

export type ExternalErasure =
  /** Erasure removes it: `erasedBy` names the exported function that does. */
  | { action: 'erased'; erasedBy: string }
  /** Nothing removes it on request; it ages out on its own after `after`. */
  | { action: 'expires'; after: string }
  | { action: 'retain'; reason: string; retention: RetentionPeriod }
  /** Erasure does not reach it yet. `gap` is the work left, so the miss is listed rather than silent. */
  | { action: 'notErased'; gap: string }
  | { action: 'noPersonalData'; note: string };

export type ExternalDataStore =
  | {
      kind: 's3';
      /** The SST resource variable in `infra/`, not the deployed bucket name. */
      bucket: string;
      holds: string;
      /** How the person's objects are found: the Mongo field holding the key, or a key prefix. */
      locatedBy: string;
      erasure: ExternalErasure;
    }
  | { kind: 'logs' | 'queues'; name: string; holds: string; erasure: ExternalErasure }
  | { kind: 'eventBus'; bus: string; holds: string; erasure: ExternalErasure }
  | {
      kind: 'service';
      name: string;
      /** What we send the service about the person. */
      receives: string;
      erasure: ExternalErasure;
      /** What stays with the service whatever we do, so the dry run can say so. */
      cannotRecall: string;
    };

export const EXTERNAL_DATA_STORES: readonly ExternalDataStore[] = [
  // S3. Lifecycle rules are in `infra/buckets.ts` and `infra/emailIngestion.ts`.
  {
    kind: 's3',
    bucket: 'fabFileBucket',
    holds: 'Uploaded knowledge files, their versions and generated copies; account and notebook download exports',
    locatedBy:
      'FabFile `filePath`, `versions.filePath`, `sourceMetadata.generatedCopyKey`; the `exports/account-data/<userId>/`, `exports/curated-notebooks/<userId>/` and `curated-notebooks/<userId>/` prefixes',
    // `purgeAccountFiles` keeps the objects of an organization's upload and of a file blocked by moderation.
    erasure: { action: 'erased', erasedBy: 'purgeAccountFiles' },
  },
  {
    kind: 's3',
    bucket: 'fabFileBucket',
    holds: 'Pre-edit copies of file content taken before an AI text edit',
    locatedBy: 'The `text-edit-backups/<userId>/` prefix (`pages/api/fabfiles/[id]/apply-edit.ts`)',
    erasure: { action: 'expires', after: '30 days (bucket lifecycle rule)' },
  },
  {
    kind: 's3',
    bucket: 'fabFileBucket',
    holds: 'Pre-edit copies written before `text-edit-backups/` existed',
    locatedBy: 'Keys containing `/backups/` under `files/<userId>/`',
    erasure: {
      action: 'notErased',
      gap: 'No lifecycle rule and no purge; only the manual `sweepLegacyBackups` script removes them',
    },
  },
  {
    kind: 's3',
    bucket: 'fabFileBucket',
    holds: 'Generated audio offloaded from a notebook message',
    locatedBy: 'The `generated-audio-offload/` prefix',
    erasure: { action: 'expires', after: '1 day (bucket lifecycle rule)' },
  },
  {
    kind: 's3',
    bucket: 'fabFileBucket',
    holds: 'Attachments shared through outgoing email',
    locatedBy: 'The `shared-email-files/<email>/` prefix (`server/utils/mailer/emailAttachments.ts`)',
    erasure: {
      action: 'notErased',
      gap: 'No lifecycle rule and no purge of the prefix; the key holds the raw email address',
    },
  },
  {
    kind: 's3',
    bucket: 'appFilesBucket',
    holds: 'App files the person uploaded, including the profile photo (`profile-photos/<userId>/`)',
    locatedBy: 'AppFile `path` (the profile photo also has an AppFile row)',
    erasure: { action: 'erased', erasedBy: 'purgeAccountFiles' },
  },
  {
    kind: 's3',
    bucket: 'appFilesBucket',
    holds: 'Voice uploads and their transcripts',
    locatedBy: 'The `transcribe-uploads/` and `transcripts/` prefixes',
    erasure: { action: 'expires', after: '1 day (bucket lifecycle rule)' },
  },
  {
    kind: 's3',
    bucket: 'appFilesBucket',
    holds: 'Per-user desktop bridge download bundles',
    locatedBy: 'The `cc-bridge-downloads/` prefix',
    erasure: { action: 'expires', after: '1 day (bucket lifecycle rule)' },
  },
  {
    kind: 's3',
    bucket: 'appFilesBucket',
    holds: "AI summaries of an organization's feedback, which can quote members",
    locatedBy: 'The `org-feedback-summaries/<organizationId>/` prefix',
    erasure: { action: 'expires', after: '14 days (bucket lifecycle rule)' },
  },
  {
    kind: 's3',
    bucket: 'generatedImagesBucket',
    holds: 'Generated images and videos in notebooks',
    // A fork copies the key, so two notebooks can share one object.
    locatedBy: 'Quest `images` and `videos`; an object goes only when no other notebook or file still references it',
    erasure: { action: 'erased', erasedBy: 'purgeAccountContent' },
  },
  {
    kind: 's3',
    bucket: 'publishedArtifactsBucket',
    holds: 'Published artifact bundles and thumbnails',
    locatedBy: 'PublishedArtifact `storageKeyPrefix`',
    erasure: { action: 'erased', erasedBy: 'purgeAccountContent' },
  },
  {
    kind: 's3',
    bucket: 'historyImportBucket',
    holds: 'Chat-history and notebook import archives',
    locatedBy: 'ImportHistoryJob `s3Key` (`<userId>/<source>/...`)',
    erasure: { action: 'erased', erasedBy: 'purgeAccountFiles' },
  },
  {
    kind: 's3',
    bucket: 'slackExportBucket',
    holds: 'Slack export archives',
    locatedBy: 'SlackExportJob `s3Key` (`exports/<userId>/...`)',
    erasure: { action: 'expires', after: '7 days (bucket lifecycle rule)' },
  },
  {
    kind: 's3',
    bucket: 'emailIngestionBucket',
    // Attachments are stored as FabFiles in `fabFileBucket`, covered by that entry.
    holds: 'Raw inbound email (`.eml`) under `raw-emails/`',
    locatedBy: 'IngestedEmail `rawEmailS3Key`',
    erasure: { action: 'expires', after: '30 days (lifecycle rule on `raw-emails/`)' },
  },
  {
    kind: 's3',
    bucket: 'qaArtifactsBucket',
    holds: 'QA run media',
    locatedBy: 'Not keyed by user',
    erasure: { action: 'noPersonalData', note: 'Recordings of test runs against test accounts' },
  },

  {
    kind: 'logs',
    name: 'CloudWatch function and server logs',
    holds:
      'User ids, IP addresses and request metadata in log lines, and the WebSocket API access log; console output is redacted by field name',
    // Default from `resolveDefaultLogging` (b4m-core/infra); some functions set their own retention in `infra/`.
    erasure: { action: 'expires', after: '1 month on production and 1 week elsewhere, unless a function sets its own' },
  },
  {
    kind: 'logs',
    name: 'WAF request logs',
    holds: 'Client IP addresses and request headers',
    erasure: { action: 'expires', after: '30 days (log group retention, `infra/waf.ts`)' },
  },
  {
    kind: 'logs',
    name: 'Slack error-log channel',
    // `formatErrorLogSlackMessage` (b4m-core/utils) drops every IP-shaped key before posting.
    holds:
      'Server error lines relayed from CloudWatch: user, session and request ids, paths and error text, no IP addresses',
    erasure: {
      action: 'notErased',
      gap: 'Retention is a Slack workspace setting, not set in code; posted messages stay until it is',
    },
  },
  {
    kind: 'queues',
    name: 'SQS work queues and their dead-letter queues',
    holds: 'Job payloads with user ids; the email queues carry addresses and message content',
    erasure: {
      action: 'expires',
      after: "Each queue's message retention: 4 days by default, 14 days on dead-letter queues",
    },
  },

  {
    kind: 'eventBus',
    bus: 'eventBus',
    holds:
      'Event payloads (an `email.send` carries the recipient and body; a push notification carries the user id), kept in a dead-letter queue when delivery fails',
    erasure: { action: 'expires', after: '14 days (dead-letter queue message retention)' },
  },

  {
    kind: 'service',
    name: 'Stripe',
    receives: 'Customer record (email, name), payment methods, subscriptions, invoices and risk metadata',
    erasure: {
      action: 'notErased',
      gap: 'Account deletion cancels subscriptions (`cancelAccountSubscriptions`) but keeps the customer: decide between deleting it and keeping it under the financial-record period',
    },
    cannotRecall: `Charges and invoices, which Stripe keeps for its own legal obligations; ours: ${FINANCIAL_RECORD.reason}`,
  },
  {
    kind: 'service',
    name: 'Outgoing email provider (SMTP)',
    receives: 'Recipient address and message content of every email sent to the person',
    erasure: { action: 'notErased', gap: 'No call removes the address from the provider' },
    cannotRecall: 'Delivered email, and the send log the provider keeps under its own retention',
  },
  {
    kind: 'service',
    name: 'AI model and content providers (LLMs; image, voice, search and scraping APIs)',
    receives: 'Prompts, attached file content, search queries and generated output',
    erasure: { action: 'expires', after: "Each provider's API data-retention term" },
    cannotRecall: 'Everything sent: no provider API deletes a past request',
  },
  {
    kind: 'service',
    name: 'Child-safety reporting authority (NCMEC)',
    receives: 'The user id and incident details of a reported image (`b4m-core/services/src/ncmecService`)',
    erasure: {
      action: 'retain',
      reason: SAFETY_INCIDENT.reason,
      retention: { expiresBy: 'condition', until: "the authority's own retention rules end it" },
    },
    cannotRecall: 'The report, once filed',
  },
  {
    kind: 'service',
    name: 'Apple Push Notification service',
    receives: 'Device token and notification text',
    erasure: { action: 'expires', after: 'Delivery: Apple holds a notification only until the device receives it' },
    cannotRecall: 'Notifications already delivered to the device',
  },
  {
    kind: 'service',
    name: 'Cloudflare Turnstile',
    receives: 'Client IP address and challenge token at sign-up and sign-in',
    erasure: { action: 'expires', after: "Cloudflare's own retention for challenge verification" },
    cannotRecall: 'Each verification request already made',
  },
  {
    kind: 'service',
    name: "The person's blog integration",
    receives: "Posts and images published to the person's own blog with their API key",
    erasure: {
      action: 'notErased',
      gap: 'The stored key is cleared with the account; published posts are not removed',
    },
    cannotRecall: "Posts already published, which live on the person's own site",
  },
  {
    kind: 'service',
    name: 'Google Drive',
    receives: "OAuth grant to the person's Drive",
    erasure: { action: 'erased', erasedBy: 'revokeIntegrationGrants' },
    cannotRecall: "Nothing of ours: the files stay in the person's own Drive",
  },
  {
    kind: 'service',
    name: 'Atlassian',
    receives: "OAuth grant to the person's Jira and Confluence",
    erasure: { action: 'erased', erasedBy: 'revokeIntegrationGrants' },
    cannotRecall: "Nothing of ours: the content stays in the person's own Atlassian site",
  },
  {
    kind: 'service',
    name: 'Notion',
    receives: "OAuth grant to the person's workspace",
    erasure: {
      action: 'notErased',
      gap: 'The stored grant is deleted but not revoked at Notion, which offers a revocation endpoint',
    },
    cannotRecall: "Nothing of ours: the pages stay in the person's own workspace",
  },
  {
    kind: 'service',
    name: 'Slack',
    receives: 'Workspace install and user tokens; messages the bot posts',
    erasure: { action: 'notErased', gap: 'No token revocation on account deletion' },
    cannotRecall: 'Messages already posted to a workspace, which belong to that workspace',
  },
  {
    kind: 'service',
    name: 'GitHub',
    receives: 'Sign-in identity and data-lake app authorization',
    erasure: { action: 'notErased', gap: 'No grant revocation on account deletion' },
    cannotRecall: 'Nothing of ours: the repositories stay with their owner',
  },
  {
    kind: 'service',
    name: 'Remote MCP servers',
    receives: 'OAuth grants to each connected server, and the tool calls made through them',
    erasure: {
      action: 'notErased',
      gap: 'Account deletion drops the stored connection without the remote revoke a disconnect makes (`revokeConnectionGrant`)',
    },
    cannotRecall: 'Tool calls already made, held by each server operator',
  },
  {
    kind: 'service',
    name: 'Sign in with Apple',
    receives: 'Sign-in identity and refresh token',
    erasure: {
      action: 'notErased',
      gap: '`revokeAppleTokens` exists but account deletion does not call it',
    },
    cannotRecall: 'Nothing beyond the grant itself',
  },
  {
    kind: 'service',
    name: 'Product analytics ingest (Overwatch)',
    receives: 'Activity events keyed by an HMAC pseudonym of the user id',
    erasure: {
      action: 'notErased',
      gap: 'No delete call; the pseudonym can be recomputed from the user id to find the events',
    },
    cannotRecall: 'Aggregates already derived from the events',
  },
];

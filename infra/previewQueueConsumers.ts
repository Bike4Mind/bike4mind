/**
 * Queue consumers that a PR preview does not run.
 *
 * An SQS-triggered Lambda is an event source mapping that long-polls its queue around the clock,
 * and those empty receives are billed whether or not anything is ever sent. Previews only exercise
 * the tester flows (chat, agents, file upload and ingest, image and media generation, auth), so the
 * consumers below are not created there. The queue and its DLQ still deploy, so a producer's send
 * succeeds and the message simply expires unread: no producer needs a missing-queue path.
 *
 * Pure (no `$app`) so infra/__tests__/previewQueueConsumers.test.ts can import it.
 * Every name here must match exactly one `subscribeUnlessPreview` call site gating the queue of that
 * name on `isPreviewStage`; that test enforces it.
 */
export const PREVIEW_SKIPPED_QUEUE_CONSUMERS = [
  // Admin-only release-notes generation.
  'whatsNewGenerationQueue',
  // Fed by the GitHub App's webhooks, which point at production and dev, not at previews.
  'githubWebhookQueue',
  'githubLakeIngestQueue',
  'githubLakeRevokeQueue',
  // Needs a connected Slack workspace.
  'slackExportQueue',
  // Ops pipelines: SRE crons only run where runsScheduledJobs is true, and the security scans,
  // SRE Slack approvals and Overwatch ingest are not wired to previews.
  'secopsTriageQueue',
  'sreFixQueue',
  'sreJobQueue',
  'overwatchAnalyticsQueue',
  // Inbound mail: the SES receipt rule that feeds the bucket exists on production and dev only.
  'emailIngestionQueue',
  'emailAnalysisQueue',
  // Admin email-marketing campaigns.
  'emailJobQueue',
  'emailBatchQueue',
] as const;

export type PreviewSkippedQueue = (typeof PREVIEW_SKIPPED_QUEUE_CONSUMERS)[number];

type Subscribable<Args extends unknown[], Subscription> = { subscribe(...args: Args): Subscription };

/**
 * `queue.subscribe(...args)` unless this is a preview stage. Returns undefined on a preview, so every
 * reader of the subscription (log forwarding, alarms, dashboards) must handle that.
 */
export function subscribeUnlessPreview<Args extends unknown[], Subscription>(
  isPreview: boolean,
  _queueName: PreviewSkippedQueue,
  queue: Subscribable<Args, Subscription>,
  ...args: Args
): Subscription | undefined {
  return isPreview ? undefined : queue.subscribe(...args);
}

import { Resource } from 'sst';
import {
  createInspectableDlqRegistry,
  describeDroppedContributions,
  partitionContributedQueues,
  reservedQueueNames,
} from '@bike4mind/infra';
import type { DlqDescriptor, InspectableDlqDescriptor, DlqResolvers } from '@bike4mind/infra';
import * as generatedInfraResources from '../premium-generated/infraResources.generated';
import { Logger } from '@bike4mind/observability';

// Mirrored by DlqReplaySafety in apps/client/app/hooks/data/dlqManagement.ts; keep both in sync.
export const DLQ_REPLAY_SAFETY = ['safe', 'side-effects', 'unsafe'] as const;
/**
 * safe: recomputes or upserts, nothing billed or sent. side-effects: can spend credits or send a notice the failed attempt never sent.
 * unsafe: can repeat a message already delivered to a person or outside system (Slack, email, webhook, chat), or the consumer is not in core.
 */
export type DlqReplaySafety = (typeof DLQ_REPLAY_SAFETY)[number];

/** Operator help for a dead-letter queue, shown on the admin Dead letters page. */
export interface DlqQueueHelp {
  /** One line: what the consumer does for the user. */
  description: string;
  replay: DlqReplaySafety;
  /** The guard (or its absence) that the replay classification rests on. */
  replayNote: string;
  /** An area name, never a person. */
  owner: string;
}

/** The record a dead letter is about, shown in the admin Dead letters table. */
export type DlqMessageEntity = { type: string; id: string };

/** Reads the entity from a parsed message body; null when the body does not name one. */
export type DlqDescribe = (body: unknown) => DlqMessageEntity | null;

export type CoreDlqDescriptor = InspectableDlqDescriptor & DlqQueueHelp & { describe: DlqDescribe };

const readPath = (value: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (current, key) =>
        typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[key] : undefined,
      value
    );

/** Describes a body as `type`, identified by the first of `paths` (dotted, array indexes allowed) holding an id. */
export function entityAt(type: string, ...paths: string[]): DlqDescribe {
  return body => {
    for (const path of paths) {
      const value = readPath(body, path);
      if (typeof value === 'string' && value.trim() !== '') return { type, id: value };
      if (typeof value === 'number' && Number.isFinite(value)) return { type, id: String(value) };
    }
    return null;
  };
}

/** For a queue that carries several message types: the first describer that recognises the body. */
export function firstEntity(...describers: DlqDescribe[]): DlqDescribe {
  return body => {
    for (const describe of describers) {
      const entity = describe(body);
      if (entity) return entity;
    }
    return null;
  };
}

/** For a queue whose bodies name no record, such as a scheduled event. */
export const noEntity: DlqDescribe = () => null;

/** The entity a raw DLQ body is about; null for a body that is not JSON or names none. */
export function describeDlqMessage(
  entry: Pick<RegisteredDlqDescriptor, 'describe'>,
  rawBody: string | undefined
): DlqMessageEntity | null {
  if (!entry.describe || !rawBody) return null;
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  return entry.describe(body);
}

/** Names each DlqQueueHelp field that is missing, blank, or (for replay) outside DLQ_REPLAY_SAFETY. */
export function missingQueueHelp(entry: Partial<Record<keyof DlqQueueHelp, unknown>>): string[] {
  const missing: string[] = [];
  for (const key of ['description', 'replayNote', 'owner'] as const) {
    const value = entry[key];
    if (typeof value !== 'string' || value.trim() === '') missing.push(key);
  }
  if (!(DLQ_REPLAY_SAFETY as readonly unknown[]).includes(entry.replay)) missing.push('replay');
  return missing;
}

/**
 * SQS queue URLs are stored via sst.Linkable in resource.enc.
 * This avoids both IAM inline policy bloat (from SST queue links) and
 * env var size limits. A single stage-scoped SQS statement in infra/web.ts covers access.
 */

/**
 * Runtime registry of DLQs, including queues without an SQS replay destination.
 * Both DLQ and source queue URLs are resolved from sst.Linkable resources
 * (dlqUrls and sourceQueueUrls) stored in resource.enc. Zero IAM overhead.
 *
 * SYNC WARNING: When adding/removing a DLQ here, also update:
 * - DLQ_DESCRIPTORS in infra/dlqAlarms.ts to keep monitoring in sync
 * - dlqUrls and sourceQueueUrls Linkables in infra/web.ts
 */
const DLQ_REGISTRY = [
  {
    label: 'fab-file-vectorize',
    displayName: 'FabFile Vectorize',
    application: 'FabFileProcessing',
    sourceQueue: 'fabFileVectorizeQueue',
    description: "Embeds a file's chunks so it can be searched from chat and knowledge bases.",
    replay: 'side-effects',
    replayNote:
      'A file that is already fully vectorized is skipped; an unfinished one embeds its remaining chunks, which reserves embedding credits.',
    owner: 'Knowledge files',
    describe: entityAt('File', 'fabFileId'),
  },
  {
    label: 'fab-file-chunk',
    displayName: 'FabFile Chunk',
    application: 'FabFileProcessing',
    sourceQueue: 'fabFileChunkQueue',
    description: 'Splits an uploaded file into text chunks ahead of vectorizing.',
    replay: 'safe',
    replayNote: 'Chunking is claimed per file, so a duplicate delivery exits instead of chunking the file twice.',
    owner: 'Knowledge files',
    describe: entityAt('File', 'fabFileId'),
  },
  {
    label: 'image-generation',
    displayName: 'Image Generation',
    application: 'ImageGeneration',
    sourceQueue: 'imageGenerationQueue',
    description: 'Generates the images for an image request in chat.',
    replay: 'side-effects',
    replayNote:
      'No completion guard: a replay calls the image provider again and holds image credits for the new attempt.',
    owner: 'Image generation',
    describe: entityAt('Quest', 'questId'),
  },
  {
    label: 'image-edit',
    displayName: 'Image Edit',
    application: 'ImageGeneration',
    sourceQueue: 'imageEditQueue',
    description: 'Applies an image edit request from chat.',
    replay: 'side-effects',
    replayNote:
      'No completion guard: a replay calls the image provider again and holds image credits for the new attempt.',
    owner: 'Image generation',
    describe: entityAt('Quest', 'questId'),
  },
  {
    label: 'generation-callback',
    displayName: 'Generation Callback',
    application: 'ImageGeneration',
    sourceQueue: 'generationCallbackQueue',
    description: 'Delivers a finished generation result to the callback URL the API caller registered.',
    replay: 'side-effects',
    replayNote:
      'Sends only while the callback is dispatched or failed and its event id still matches, so a replay retries a failed callback once.',
    owner: 'Public API',
    describe: entityAt('Quest', 'questId'),
  },
  {
    label: 'data-lake-research',
    displayName: 'Data Lake Research Run',
    application: 'DataLakeManagement',
    sourceQueue: 'dataLakeResearchQueue',
    description: 'Runs a queued data lake research run.',
    replay: 'side-effects',
    replayNote:
      'The run is claimed before it starts, so a run already claimed or settled is skipped; a run still queued runs now and makes its LLM calls.',
    owner: 'Data lake',
    describe: entityAt('Research run', 'runId'),
  },
  {
    label: 'research-engine',
    displayName: 'Research Engine',
    application: 'ResearchEngine',
    sourceQueue: 'researchEngineQueue',
    description: 'Runs a research task: scrapes its sources and stores the results.',
    replay: 'side-effects',
    replayNote: 'A replay re-runs the scrape and the LLM calls for the task, spending credits again.',
    owner: 'Research',
    describe: firstEntity(entityAt('Quest', 'payload.questId'), entityAt('Research task', 'payload.id')),
  },
  {
    label: 'release-notes',
    displayName: 'Release Notes and Highlights',
    application: 'ReleaseNotes',
    sourceQueue: 'whatsNewGenerationQueue',
    description: 'Writes release notes or weekly highlights and announces them in Slack.',
    replay: 'unsafe',
    replayNote:
      'Nothing records that the Slack announcement went out, so a replay regenerates the note and posts again. Only a human-edited note is left alone.',
    owner: 'Release notes',
    describe: entityAt('Release', 'releaseTag'),
  },
  {
    label: 'whats-new-highlights',
    displayName: "What's New Highlights",
    application: 'WhatsNewGeneration',
    sourceQueue: 'whatsNewHighlightsQueue',
    description: "Builds the weekly What's New highlights and posts them to Slack.",
    replay: 'unsafe',
    replayNote: 'Nothing records an earlier Slack post, so a replay posts the highlights again.',
    owner: 'Release notes',
    describe: entityAt('Highlights run', 'correlationId'),
  },
  {
    label: 'notebook-curation',
    displayName: 'Notebook Curation',
    application: 'NotebookCuration',
    sourceQueue: 'notebookCurationQueue',
    description: 'Curates a chat session into a notebook with an LLM.',
    replay: 'side-effects',
    replayNote:
      'A curation job that already completed is skipped; a failed or unfinished one runs the LLM again and charges credits.',
    owner: 'Notebooks',
    describe: entityAt('Notebook', 'sessionId'),
  },
  {
    label: 'agent-proactive-message',
    displayName: 'Agent Proactive Message',
    application: 'AgentMessaging',
    sourceQueue: 'agentProactiveMessageQueue',
    description: 'Has a session agent write and send a proactive message into the chat.',
    replay: 'unsafe',
    replayNote: 'No dedup on the message: a replay writes and sends another message to the user and spends credits.',
    owner: 'Agents',
    describe: entityAt('Agent config', 'sessionAgentConfigId'),
  },
  {
    label: 'github-webhook',
    displayName: 'GitHub Webhook',
    application: 'GitHubWebhooks',
    sourceQueue: 'githubWebhookQueue',
    description: 'Processes a GitHub webhook event and notifies the subscribed users.',
    replay: 'unsafe',
    replayNote:
      'Subscribers already recorded for this GitHub delivery id are skipped, but those records expire after 7 days, so a later replay notifies every subscriber again.',
    owner: 'Integrations',
    describe: entityAt('Webhook delivery', 'deliveryId'),
  },
  {
    label: 'webhook-delivery',
    displayName: 'Webhook Delivery',
    application: 'WebhookDelivery',
    sourceQueue: 'webhookDeliveryQueue',
    description: "Sends an event to a customer's webhook endpoint.",
    replay: 'unsafe',
    replayNote:
      'The 1-hour dedup cache has usually expired by replay time, so the POST is sent again; receivers can drop it by its stable eventId.',
    owner: 'Integrations',
    describe: entityAt('Webhook subscription', 'subscriptionId'),
  },
  {
    label: 'slack-export',
    displayName: 'Slack Export',
    application: 'SlackExport',
    sourceQueue: 'slackExportQueue',
    description: 'Exports Slack channel history to a downloadable file.',
    replay: 'safe',
    replayNote:
      'A cancelled job is skipped; otherwise the export is rebuilt from Slack and uploaded again, with nothing sent outside.',
    owner: 'Integrations',
    describe: entityAt('Export job', 'jobId'),
  },
  {
    label: 'quest-export',
    displayName: 'Quest Export',
    application: 'QuestExport',
    sourceQueue: 'questExportQueue',
    description: 'Builds a downloadable ZIP export of a quest.',
    replay: 'side-effects',
    replayNote:
      'If the ZIP already exists only the completed event is re-sent; otherwise the ZIP is rebuilt, which can call the summary model again.',
    owner: 'Chat',
    describe: firstEntity(entityAt('Export job', 'exportJobId'), entityAt('Feedback summary job', 'summaryJobId')),
  },
  {
    label: 'account-data-export',
    displayName: 'Account Data Export',
    application: 'AccountDataExport',
    sourceQueue: 'accountDataExportQueue',
    description: 'Builds account data or organization metadata exports and emails an authenticated download link.',
    replay: 'unsafe',
    replayNote: 'An export that was already built is not rebuilt, but the ready email is sent again.',
    owner: 'Accounts',
    describe: entityAt('Export job', 'exportJobId'),
  },
  {
    label: 'account-erasure',
    displayName: 'Account Erasure',
    application: 'AccountErasure',
    sourceQueue: 'accountErasureQueue',
    description: 'Runs the account purge for a user an admin scheduled for data subject erasure.',
    replay: 'safe',
    replayNote:
      'The purge is leased and idempotent, so a replay finishes an interrupted erasure; a user already deleted is skipped.',
    owner: 'Accounts',
    describe: entityAt('User', 'userId'),
  },
  {
    label: 'generation-job',
    displayName: 'Generation Job',
    application: 'GenerationJob',
    sourceQueue: 'generationJobQueue',
    description: 'Advances a long-running generation job by one step.',
    replay: 'side-effects',
    replayNote:
      'Each step reads the stored job state, but a replay can call the model again. Only the step that claims the finished job sends the ready push.',
    owner: 'Generation jobs',
    describe: entityAt('Job', 'jobId'),
  },
  {
    label: 'liveops-triage',
    displayName: 'LiveOps Triage',
    application: 'LiveOpsTriage',
    sourceQueue: 'liveOpsTriageQueue',
    description: 'Triages recent Slack alerts into issue tracker tickets for a LiveOps config.',
    replay: 'unsafe',
    replayNote:
      'A run within 5 minutes of the last one is skipped and duplicate issues are deduplicated, but a later replay runs a fresh triage and posts the Slack summary again.',
    owner: 'Platform ops',
    describe: entityAt('Triage config', 'configId'),
  },
  {
    label: 'sre-fix',
    displayName: 'SRE Fix',
    application: 'SreAgent',
    sourceQueue: 'sreFixQueue',
    description: 'Dispatches the SRE agent to open a fix for a tracked error.',
    replay: 'side-effects',
    replayNote:
      'Dispatch is claimed on the error record before GitHub is called, so a replay after a dispatch is skipped. If GitHub is unavailable at replay time, the fix is marked failed and a Slack failure notice is posted.',
    owner: 'Platform ops',
    describe: entityAt('SRE fix', 'trackingId', 'detail.trackingId'),
  },
  {
    label: 'sre-job',
    displayName: 'SRE Job',
    application: 'SreAgent',
    sourceQueue: 'sreJobQueue',
    description: 'Runs SRE agent analysis or revision for a tracked error.',
    replay: 'side-effects',
    replayNote:
      'Analysis is claimed per error fingerprint and GitHub comments check for an existing marker, but a replay can still call the model again.',
    owner: 'Platform ops',
    describe: firstEntity(entityAt('SRE incident', 'fingerprint'), entityAt('SRE fix', 'trackingId')),
  },
  {
    label: 'email-ingestion',
    displayName: 'Email Ingestion',
    application: 'EmailIngestion',
    sourceQueue: 'emailIngestionQueue',
    description: 'Parses an inbound email from storage and files it for the user.',
    replay: 'side-effects',
    replayNote:
      'Mail with a Message-ID that was already ingested for the user is not stored twice. Mail without one gets a new id, so a replay stores it again and queues another billed analysis.',
    owner: 'Email ingestion',
    describe: entityAt('Email object', 'Records.0.s3.object.key'),
  },
  {
    label: 'email-analysis',
    displayName: 'Email Analysis',
    application: 'EmailIngestion',
    sourceQueue: 'emailAnalysisQueue',
    description: 'Analyzes an ingested email with an LLM and stores the result on it.',
    replay: 'side-effects',
    replayNote: 'An email that already has an analysis is skipped; otherwise the LLM runs again and is billed.',
    owner: 'Email ingestion',
    describe: entityAt('Email', 'emailId'),
  },
  {
    label: 'email-batch',
    displayName: 'Email Batch',
    application: 'EmailMarketing',
    sourceQueue: 'emailBatchQueue',
    description: 'Sends one batch of a marketing email campaign.',
    replay: 'side-effects',
    replayNote:
      'Only recipients still marked pending are mailed, so a replay sends the rest of the batch without resending delivered mail.',
    owner: 'Email marketing',
    describe: entityAt('Email job', 'jobId'),
  },
  {
    label: 'email-job',
    displayName: 'Email Job',
    application: 'EmailMarketing',
    sourceQueue: 'emailJobQueue',
    description: 'Starts a marketing email campaign: resolves its recipients and queues the send batches.',
    replay: 'unsafe',
    replayNote:
      'No status guard: a replay creates new send attempts for every recipient and mails the whole campaign again.',
    owner: 'Email marketing',
    describe: entityAt('Email job', 'jobId'),
  },
  {
    label: 'tavern-heartbeat',
    displayName: 'Tavern Heartbeat',
    application: 'TavernHeartbeat',
    sourceQueue: 'tavernHeartbeatQueue',
    description: 'Processes queued Tavern Heartbeat messages.',
    replay: 'unsafe',
    replayNote: 'Handled by a premium module; confirm with the owner before replaying.',
    owner: 'Premium integrations',
    describe: entityAt('Agent', 'agentId'),
  },
  {
    label: 'deep-agent-wake',
    displayName: 'Deep Agent Wake',
    application: 'DeepAgent',
    sourceQueue: 'deepAgentWakeQueue',
    description: "Runs one wake cycle for a deep agent's mission.",
    replay: 'side-effects',
    replayNote:
      "No dedup on the wake: a replay runs one more cycle, calling the model and spending the mission's credits.",
    owner: 'Agents',
    describe: entityAt('Agent', 'agentId'),
  },
  {
    label: 'secops-triage',
    displayName: 'SecOps Triage',
    application: 'SecOpsTriage',
    sourceQueue: 'secopsTriageQueue',
    description: 'Triages recent security alerts into issue tracker tickets.',
    replay: 'unsafe',
    replayNote:
      'Matching open issues are updated rather than duplicated, but a replay runs a fresh triage and can post the Slack summary again.',
    owner: 'Security ops',
    describe: entityAt('Scan snapshot', 'snapshotId'),
  },
  {
    label: 'overwatch-analytics',
    displayName: 'Overwatch Analytics',
    application: 'OverwatchAnalytics',
    sourceQueue: 'overwatchAnalyticsQueue',
    description: 'Processes queued Overwatch Analytics messages.',
    replay: 'unsafe',
    replayNote: 'Handled by a premium module; confirm with the owner before replaying.',
    owner: 'Premium integrations',
    describe: entityAt('Analytics event', 'eventId'),
  },
  {
    label: 'agent-continuation',
    displayName: 'Agent Continuation',
    application: 'AgentExecutor',
    sourceQueue: 'agentContinuationQueue',
    description: 'Resumes a long-running agent execution from its last checkpoint.',
    replay: 'side-effects',
    replayNote:
      'The execution is claimed atomically from a resumable status, so a replay of a run that moved on exits; otherwise the agent resumes and spends credits.',
    owner: 'Agents',
    describe: entityAt('Agent execution', 'childExecutionId', 'executionId'),
  },
  {
    label: 'optihashi-run-completion',
    displayName: 'OptiHashi Run Completion',
    application: 'OptiHashiIntegration',
    sourceQueue: 'optihashiRunCompletionQueue',
    description: 'Processes queued OptiHashi Run Completion messages.',
    replay: 'unsafe',
    replayNote: 'Handled by a premium module; confirm with the owner before replaying.',
    owner: 'Premium integrations',
    describe: entityAt('Run', 'runId'),
  },
  {
    label: 'bob-run',
    displayName: 'Bob Panel Run',
    application: 'BobIntegration',
    sourceQueue: 'bobRunQueue',
    description: 'Processes queued Bob Panel Run messages.',
    replay: 'unsafe',
    replayNote: 'Handled by a premium module; confirm with the owner before replaying.',
    owner: 'Premium integrations',
    describe: entityAt('Run', 'runId'),
  },
  {
    label: 'libreoncology-audio-render',
    displayName: 'LibreOncology Audio Render',
    application: 'LibreOncologyIntegration',
    sourceQueue: 'libreoncologyAudioRenderQueue',
    description: 'Processes queued LibreOncology Audio Render messages.',
    replay: 'unsafe',
    replayNote: 'Handled by a premium module; confirm with the owner before replaying.',
    owner: 'Premium integrations',
    describe: noEntity,
  },
  {
    label: 'data-lake-cleanup',
    displayName: 'Data Lake Cleanup',
    application: 'DataLakeManagement',
    sourceQueue: 'dataLakeCleanupQueue',
    description: "Hard-deletes a deleted data lake's files, chunks and stored objects.",
    replay: 'safe',
    replayNote: 'The cleanup is guarded and idempotent, so a replay only removes what an earlier run left behind.',
    owner: 'Data lake',
    describe: entityAt('Data lake', 'dataLakeId'),
  },
  {
    label: 'data-lake-taxonomy',
    displayName: 'Data Lake Taxonomy Analysis',
    application: 'DataLakeManagement',
    sourceQueue: 'dataLakeTaxonomyQueue',
    description: 'Infers an AI taxonomy for a newly ingested data lake batch.',
    replay: 'side-effects',
    replayNote:
      'The batch is claimed first and a finalized batch is skipped; a batch still queued runs the model again and is billed.',
    owner: 'Data lake',
    describe: entityAt('Data lake', 'dataLakeId'),
  },
  {
    label: 'lake-memory',
    displayName: 'Lake Memory Extraction',
    application: 'DataLakeManagement',
    sourceQueue: 'lakeMemoryQueue',
    description: "Extracts memory beliefs from a data lake's contents.",
    replay: 'side-effects',
    replayNote:
      'The ledger de-duplicates beliefs so nothing is stored twice, but a replay re-scans the lake and bills the LLM again.',
    owner: 'Data lake',
    describe: entityAt('Data lake', 'dataLakeId'),
  },
  {
    label: 'risk-evidence',
    displayName: 'Account Risk Evidence',
    application: 'Signup',
    sourceQueue: 'riskEvidenceQueue',
    description: "Rebuilds an account's activity evidence summary off the request path.",
    replay: 'side-effects',
    replayNote:
      'The summary is recomputed from stored activity. A signup replay also runs the linked-account check the failed attempt skipped, which can contain the account; an account the check already recorded is skipped.',
    owner: 'Account security',
    describe: entityAt('User', 'userId'),
  },
  {
    label: 'lake-inconsistency-model',
    displayName: 'Lake Model Inconsistency Detection',
    application: 'DataLakeManagement',
    sourceQueue: 'lakeInconsistencyModelQueue',
    description: 'Runs model-based contradiction detection over a data lake and stores the findings for review.',
    replay: 'side-effects',
    replayNote: 'Runs under a per-lake lease; a replay makes the LLM calls again and charges the lake owner.',
    owner: 'Data lake',
    describe: entityAt('Data lake', 'dataLakeId'),
  },
  {
    label: 'drive-lake-ingest',
    displayName: 'Drive Lake Ingest',
    application: 'DataLakeManagement',
    sourceQueue: 'driveLakeIngestQueue',
    description: 'Syncs a connected Google Drive folder into its data lake.',
    replay: 'safe',
    replayNote:
      'The sync claims the connection first and skips files it already ingested, so a replay only picks up new or unfinished work.',
    owner: 'Data lake',
    describe: entityAt('Drive connection', 'connectionId'),
  },
  {
    label: 'drive-disconnect-purge',
    displayName: 'Drive Disconnect Purge',
    application: 'DataLakeManagement',
    sourceQueue: 'driveDisconnectPurgeQueue',
    description: 'Removes the files a disconnected Google Drive folder ingested, then releases the connection.',
    replay: 'safe',
    replayNote:
      'Each run re-reads what is left and a released connection is skipped, so a replay finishes the purge without double-counting.',
    owner: 'Data lake',
    describe: entityAt('Data lake', 'dataLakeId'),
  },
  {
    label: 'github-lake-ingest',
    displayName: 'GitHub Lake Ingest',
    application: 'DataLakeManagement',
    sourceQueue: 'githubLakeIngestQueue',
    description: "Syncs a connected GitHub repository's default branch into its data lake.",
    replay: 'safe',
    replayNote:
      'The sync claims the connection first and skips files it already ingested, so a replay only picks up new or unfinished work.',
    owner: 'Data lake',
    describe: entityAt('GitHub connection', 'connectionId'),
  },
  {
    label: 'github-lake-revoke',
    displayName: 'GitHub Lake Revoke',
    application: 'DataLakeManagement',
    sourceQueue: 'githubLakeRevokeQueue',
    description: 'Removes what a GitHub lake connection ingested, then releases the connection.',
    replay: 'safe',
    replayNote: 'A retry finishes the purge even after the connection row is gone, so a replay only completes it.',
    owner: 'Data lake',
    describe: entityAt('GitHub connection', 'connectionId'),
  },
  {
    label: 'publish-thumbnail',
    displayName: 'Published Artifact Thumbnail',
    application: 'PublishedArtifacts',
    sourceQueue: 'publishThumbnailQueue',
    description: 'Renders and stores the preview thumbnail for a published artifact.',
    replay: 'safe',
    replayNote:
      'A job superseded by a newer version is dropped; otherwise the thumbnail is rendered and stored again, with nothing sent outside.',
    owner: 'Published artifacts',
    describe: entityAt('Published artifact', 'publicId'),
  },
  {
    label: 'young-account-spend-alert',
    displayName: 'Young Account Spend Alert',
    application: 'Signup',
    sourceQueue: null,
    replay: 'unsafe',
    description: 'Retains failed young-account spend alert invocations for inspection.',
    replayNote: 'No SQS replay destination; inspect the failed invocation before manual recovery.',
    owner: 'Account security',
    describe: noEntity,
  },
  {
    label: 'api-probe-detector',
    displayName: 'API Probe Detector',
    application: 'Security',
    sourceQueue: null,
    replay: 'unsafe',
    description: 'Retains failed API probe detector invocations for inspection.',
    replayNote: 'No SQS replay destination; inspect the failed invocation before manual recovery.',
    owner: 'Security ops',
    describe: noEntity,
  },
  {
    label: 'image-moderation-review-sweep',
    displayName: 'Image Moderation Review Sweep',
    application: 'Moderation',
    sourceQueue: null,
    replay: 'unsafe',
    description: 'Retains failed image moderation review sweep invocations for inspection.',
    replayNote: 'No SQS replay destination; inspect the failed invocation before manual recovery.',
    owner: 'Moderation',
    describe: noEntity,
  },
  {
    label: 'spend-monitor',
    displayName: 'Spend Monitor',
    application: 'Billing',
    sourceQueue: null,
    replay: 'unsafe',
    description: 'Retains failed spend monitor invocations for inspection.',
    replayNote: 'No SQS replay destination; inspect the failed invocation before manual recovery.',
    owner: 'Billing',
    describe: noEntity,
  },
  {
    label: 'signup-grant-held-release',
    displayName: 'Signup Grant Held Release',
    application: 'Signup',
    sourceQueue: null,
    replay: 'unsafe',
    description: 'Retains failed signup grant release invocations for inspection.',
    replayNote: 'No SQS replay destination; inspect the failed invocation before manual recovery.',
    owner: 'Accounts',
    describe: noEntity,
  },
  {
    label: 'revenue-snapshot',
    displayName: 'Revenue Snapshot',
    application: 'Billing',
    sourceQueue: null,
    replay: 'unsafe',
    description: 'Retains failed revenue snapshot invocations for inspection.',
    replayNote: 'No SQS replay destination; inspect the failed invocation before manual recovery.',
    owner: 'Billing',
    describe: noEntity,
  },
  {
    label: 'subscription-reconciliation',
    displayName: 'Subscription Reconciliation',
    application: 'Billing',
    sourceQueue: null,
    replay: 'unsafe',
    description: 'Retains failed subscription reconciliation invocations for inspection.',
    replayNote: 'No SQS replay destination; inspect the failed invocation before manual recovery.',
    owner: 'Billing',
    describe: noEntity,
  },
  {
    label: 'account-deletion-sweep',
    displayName: 'Account Deletion Sweep',
    application: 'Account',
    sourceQueue: null,
    replay: 'unsafe',
    description: 'Retains failed account deletion sweep invocations for inspection.',
    replayNote: 'No SQS replay destination; inspect the failed invocation before manual recovery.',
    owner: 'Accounts',
    describe: noEntity,
  },
  {
    label: 'fab-file-moderation',
    displayName: 'FabFile Moderation',
    application: 'FabFileProcessing',
    sourceQueue: null,
    replay: 'unsafe',
    description: 'Retains failed file upload moderation invocations for inspection.',
    replayNote: 'S3 invokes the consumer directly; there is no SQS replay destination.',
    owner: 'Knowledge files',
    describe: entityAt('File path', 'Records.0.s3.object.key'),
  },
  {
    label: 'telemetry-alert-rule',
    displayName: 'Telemetry Alert Rule',
    application: 'TelemetryAlerts',
    sourceQueue: null,
    replay: 'unsafe',
    description: 'Retains telemetry alert events that could not be delivered or processed.',
    replayNote: 'No SQS replay destination; inspect the event before manual recovery.',
    owner: 'Platform ops',
    describe: entityAt('Quest', 'detail.requestId'),
  },
  {
    label: 'session-enrichment',
    displayName: 'Session Enrichment',
    application: 'SessionEnrichment',
    sourceQueue: null,
    replay: 'unsafe',
    description: 'Retains session enrichment events that could not be delivered or processed.',
    replayNote: 'No SQS replay destination; inspect the event before manual recovery.',
    owner: 'Chat',
    describe: entityAt('Notebook', 'detail.sessionId'),
  },
  {
    label: 'billing-events',
    displayName: 'Billing Events',
    application: 'Billing',
    sourceQueue: null,
    replay: 'unsafe',
    description: 'Retains billing events that could not be delivered or processed.',
    replayNote: 'No SQS replay destination; inspect the event before manual recovery.',
    owner: 'Billing',
    describe: firstEntity(entityAt('Invoice', 'detail.invoiceId'), entityAt('Subscription', 'detail.subscriptionId')),
  },
  {
    label: 'email-events',
    displayName: 'Email Events',
    application: 'Email',
    sourceQueue: null,
    replay: 'unsafe',
    description: 'Retains email events that could not be delivered or processed.',
    replayNote: 'No SQS replay destination; inspect the event before manual recovery.',
    owner: 'Email',
    describe: noEntity,
  },
  {
    label: 'push-events',
    displayName: 'Push Events',
    application: 'Notifications',
    sourceQueue: null,
    replay: 'unsafe',
    description: 'Retains push notification events that could not be delivered or processed.',
    replayNote: 'No SQS replay destination; inspect the event before manual recovery.',
    owner: 'Notifications',
    describe: entityAt('User', 'detail.userId'),
  },
  {
    label: 'notebook-events',
    displayName: 'Notebook Events',
    application: 'NotebookCuration',
    sourceQueue: null,
    replay: 'unsafe',
    description: 'Retains notebook events that could not be delivered or processed.',
    replayNote: 'No SQS replay destination; inspect the event before manual recovery.',
    owner: 'Notebooks',
    describe: firstEntity(entityAt('Notebook', 'detail.sessionId'), entityAt('Spider job', 'detail.spiderJobId')),
  },
  {
    label: 'completion-events',
    displayName: 'Completion Events',
    application: 'Completions',
    sourceQueue: null,
    replay: 'unsafe',
    description: 'Retains completion events that could not be delivered or processed.',
    replayNote: 'No SQS replay destination; inspect the event before manual recovery.',
    owner: 'Chat',
    describe: entityAt('Quest', 'detail.questId'),
  },
  {
    label: 'business-metric-alerts',
    displayName: 'Business Metric Alerts',
    application: 'Analytics',
    sourceQueue: null,
    replay: 'unsafe',
    description: 'Retains failed business metric alert invocations for inspection.',
    replayNote: 'No SQS replay destination; inspect the failed invocation before manual recovery.',
    owner: 'Analytics',
    describe: noEntity,
  },
  {
    label: 'alarm-handler',
    displayName: 'DLQ Alarm Handler',
    application: 'AlarmPipeline',
    sourceQueue: null,
    replay: 'unsafe',
    description: 'Retains alarm notifications that could not reach the alarm handler.',
    replayNote: 'SNS delivers notifications directly; there is no SQS replay destination.',
    owner: 'Platform ops',
    describe: entityAt('Alarm', 'AlarmName'),
  },
  {
    label: 'generated-media-purge',
    displayName: 'Generated Media Purge',
    application: 'Notebooks',
    sourceQueue: 'generatedMediaPurgeQueue',
    description: 'Deletes generated images, audio and video left behind when a message or notebook is deleted.',
    replay: 'safe',
    replayNote:
      'Each key is rechecked against live references and notebook ownership before it is deleted, and deleting a key that is already gone is a no-op.',
    owner: 'Notebooks',
    describe: entityAt('Notebook', 'sessionIds.0'),
  },
] as const satisfies readonly CoreDlqDescriptor[];

type CoreDlqLabel = (typeof DLQ_REGISTRY)[number]['label'];
type CoreSourceQueueName = NonNullable<(typeof DLQ_REGISTRY)[number]['sourceQueue']>;

declare const contributedBrand: unique symbol;
/** A DLQ label an overlay declared; obtained from contributedDlqLabel, which checks registration. */
export type ContributedDlqLabel = string & { readonly [contributedBrand]: 'dlqLabel' };
/** A source queue an overlay declared; obtained from contributedSourceQueueName. */
export type ContributedSourceQueueName = string & { readonly [contributedBrand]: 'sourceQueue' };

export type DlqLabel = CoreDlqLabel | ContributedDlqLabel;
/** Valid source queue names: DLQ_REGISTRY's, plus the contributed ones that registered. */
export type SourceQueueName = CoreSourceQueueName | ContributedSourceQueueName;

/** An entry the registry holds; a null source queue has no SQS replay destination. */
export type RegisteredDlqDescriptor = InspectableDlqDescriptor &
  Partial<DlqQueueHelp> & { label: DlqLabel; sourceQueue: SourceQueueName | null; describe?: DlqDescribe };

type LinkableQueues = {
  dlqUrls: Record<string, string>;
  sourceQueueUrls: Record<string, string>;
};

const resolvers: DlqResolvers = {
  resolveDlqUrl: label => (Resource as unknown as LinkableQueues).dlqUrls?.[label],
  resolveSourceQueueUrl: name => (Resource as unknown as LinkableQueues).sourceQueueUrls?.[name],
};

// infra/queues.ts partitions the same specs against the same reservedQueueNames, so the
// registry lists exactly the pairs that deploy. Registers nothing when codegen could not read
// the core names, or read names this file's DLQ_REGISTRY contradicts (a stale generated file).
function contributedDescriptors(): DlqDescriptor[] {
  const specs = generatedInfraResources.contributedInfraResources.queues;
  if (specs.length === 0) return [];
  const reserved = reservedQueueNames(generatedInfraResources);
  if (reserved === null) {
    Logger.warn(
      '[dlqRegistry] core resource names unknown (codegen ran without infra/); no contributed DLQ registered'
    );
    return [];
  }
  const labels = new Set(reserved.dlqLabels);
  const names = new Set(reserved.resourceNames);
  const unknown = DLQ_REGISTRY.filter(
    d => !labels.has(d.label) || (d.sourceQueue !== null && !names.has(d.sourceQueue))
  ).map(d => d.label);
  if (unknown.length > 0) {
    Logger.warn(
      `[dlqRegistry] generated core names miss DLQ_REGISTRY entries (${unknown.join(', ')}); re-run pnpm codegen. ` +
        'No contributed DLQ registered'
    );
    return [];
  }
  const result = partitionContributedQueues(specs, reserved);
  for (const line of describeDroppedContributions('contributed queue', result)) Logger.warn(`[dlqRegistry] ${line}`);
  return result.registered.map(({ label, displayName, application, name }) => ({
    label,
    displayName,
    application,
    sourceQueue: name,
  }));
}

let registry: ReturnType<typeof createInspectableDlqRegistry<readonly InspectableDlqDescriptor[]>> | undefined;
const contributedLabels = new Set<string>();
const contributedSourceQueues = new Set<string>();

function getRegistry() {
  if (!registry) {
    const contributed = contributedDescriptors();
    for (const d of contributed) {
      contributedLabels.add(d.label);
      if (d.sourceQueue !== null) contributedSourceQueues.add(d.sourceQueue);
    }
    registry = createInspectableDlqRegistry<readonly InspectableDlqDescriptor[]>(
      [...DLQ_REGISTRY, ...contributed],
      resolvers,
      {
        dlqErrorContext: 'Check dlqUrls Linkable in infra/web.ts.',
        sourceQueueErrorContext: 'Check sourceQueueUrls Linkable in infra/web.ts.',
      }
    );
  }
  return registry;
}

/** Narrows an overlay's DLQ label; throws when it was dropped or never declared. */
export function contributedDlqLabel(label: string): ContributedDlqLabel {
  getRegistry();
  if (!contributedLabels.has(label)) throw new Error(`Contributed DLQ label not registered: ${label}`);
  return label as ContributedDlqLabel;
}

/** Narrows an overlay's source queue name; throws when it was dropped or never declared. */
export function contributedSourceQueueName(name: string): ContributedSourceQueueName {
  getRegistry();
  if (!contributedSourceQueues.has(name)) throw new Error(`Contributed source queue not registered: ${name}`);
  return name as ContributedSourceQueueName;
}

/** The core entries only, without overlay contributions. */
export function coreDlqDescriptors(): readonly CoreDlqDescriptor[] {
  return DLQ_REGISTRY;
}

export function getDlqRegistry(): readonly RegisteredDlqDescriptor[] {
  return getRegistry().getAllDescriptors() as readonly RegisteredDlqDescriptor[];
}

export function getDlqByLabel(label: string): RegisteredDlqDescriptor | undefined {
  return getRegistry().getDlqByLabel(label) as RegisteredDlqDescriptor | undefined;
}

export function getDlqUrl(label: DlqLabel): string {
  return getRegistry().getDlqUrl(label);
}

/**
 * Get a source queue URL from the sourceQueueUrls Linkable.
 * Exported for use by queue handlers, API routes, and cron jobs.
 */
export function getSourceQueueUrl(name: SourceQueueName): string {
  return getRegistry().getSourceQueueUrl(name);
}

export function resetDlqRegistryForTests(): void {
  registry = undefined;
  contributedLabels.clear();
  contributedSourceQueues.clear();
}

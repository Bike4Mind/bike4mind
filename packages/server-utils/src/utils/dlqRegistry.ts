import { Resource } from 'sst';
import {
  createDlqRegistry,
  describeDroppedContributions,
  partitionContributedQueues,
  reservedQueueNames,
} from '@bike4mind/infra';
import type { DlqDescriptor, DlqResolvers } from '@bike4mind/infra';
import * as generatedInfraResources from '../premium-generated/infraResources.generated';
import { Logger } from '@bike4mind/observability';

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
  },
  {
    label: 'fab-file-chunk',
    displayName: 'FabFile Chunk',
    application: 'FabFileProcessing',
    sourceQueue: 'fabFileChunkQueue',
  },
  {
    label: 'image-generation',
    displayName: 'Image Generation',
    application: 'ImageGeneration',
    sourceQueue: 'imageGenerationQueue',
  },
  {
    label: 'image-edit',
    displayName: 'Image Edit',
    application: 'ImageGeneration',
    sourceQueue: 'imageEditQueue',
  },
  {
    label: 'generation-callback',
    displayName: 'Generation Callback',
    application: 'ImageGeneration',
    sourceQueue: 'generationCallbackQueue',
  },
  {
    label: 'data-lake-research',
    displayName: 'Data Lake Research Run',
    application: 'DataLakeManagement',
    sourceQueue: 'dataLakeResearchQueue',
  },
  {
    label: 'research-engine',
    displayName: 'Research Engine',
    application: 'ResearchEngine',
    sourceQueue: 'researchEngineQueue',
  },
  {
    label: 'release-notes',
    displayName: 'Release Notes and Highlights',
    application: 'ReleaseNotes',
    sourceQueue: 'whatsNewGenerationQueue',
  },
  {
    label: 'whats-new-highlights',
    displayName: "What's New Highlights",
    application: 'WhatsNewGeneration',
    sourceQueue: 'whatsNewHighlightsQueue',
  },
  {
    label: 'notebook-curation',
    displayName: 'Notebook Curation',
    application: 'NotebookCuration',
    sourceQueue: 'notebookCurationQueue',
  },
  {
    label: 'agent-proactive-message',
    displayName: 'Agent Proactive Message',
    application: 'AgentMessaging',
    sourceQueue: 'agentProactiveMessageQueue',
  },
  {
    label: 'github-webhook',
    displayName: 'GitHub Webhook',
    application: 'GitHubWebhooks',
    sourceQueue: 'githubWebhookQueue',
  },
  {
    label: 'webhook-delivery',
    displayName: 'Webhook Delivery',
    application: 'WebhookDelivery',
    sourceQueue: 'webhookDeliveryQueue',
  },
  {
    label: 'slack-export',
    displayName: 'Slack Export',
    application: 'SlackExport',
    sourceQueue: 'slackExportQueue',
  },
  {
    label: 'quest-export',
    displayName: 'Quest Export',
    application: 'QuestExport',
    sourceQueue: 'questExportQueue',
  },
  {
    label: 'account-data-export',
    displayName: 'Account Data Export',
    application: 'AccountDataExport',
    sourceQueue: 'accountDataExportQueue',
  },
  {
    label: 'generation-job',
    displayName: 'Generation Job',
    application: 'GenerationJob',
    sourceQueue: 'generationJobQueue',
  },
  {
    label: 'liveops-triage',
    displayName: 'LiveOps Triage',
    application: 'LiveOpsTriage',
    sourceQueue: 'liveOpsTriageQueue',
  },
  {
    label: 'sre-fix',
    displayName: 'SRE Fix',
    application: 'SreAgent',
    sourceQueue: 'sreFixQueue',
  },
  {
    label: 'sre-job',
    displayName: 'SRE Job',
    application: 'SreAgent',
    sourceQueue: 'sreJobQueue',
  },
  {
    label: 'email-ingestion',
    displayName: 'Email Ingestion',
    application: 'EmailIngestion',
    sourceQueue: 'emailIngestionQueue',
  },
  {
    label: 'email-analysis',
    displayName: 'Email Analysis',
    application: 'EmailIngestion',
    sourceQueue: 'emailAnalysisQueue',
  },
  {
    label: 'email-batch',
    displayName: 'Email Batch',
    application: 'EmailMarketing',
    sourceQueue: 'emailBatchQueue',
  },
  {
    label: 'email-job',
    displayName: 'Email Job',
    application: 'EmailMarketing',
    sourceQueue: 'emailJobQueue',
  },
  {
    label: 'tavern-heartbeat',
    displayName: 'Tavern Heartbeat',
    application: 'TavernHeartbeat',
    sourceQueue: 'tavernHeartbeatQueue',
  },
  {
    label: 'deep-agent-wake',
    displayName: 'Deep Agent Wake',
    application: 'DeepAgent',
    sourceQueue: 'deepAgentWakeQueue',
  },
  {
    label: 'secops-triage',
    displayName: 'SecOps Triage',
    application: 'SecOpsTriage',
    sourceQueue: 'secopsTriageQueue',
  },
  {
    label: 'overwatch-analytics',
    displayName: 'Overwatch Analytics',
    application: 'OverwatchAnalytics',
    sourceQueue: 'overwatchAnalyticsQueue',
  },
  {
    label: 'agent-continuation',
    displayName: 'Agent Continuation',
    application: 'AgentExecutor',
    sourceQueue: 'agentContinuationQueue',
  },
  {
    label: 'optihashi-run-completion',
    displayName: 'OptiHashi Run Completion',
    application: 'OptiHashiIntegration',
    sourceQueue: 'optihashiRunCompletionQueue',
  },
  {
    label: 'bob-run',
    displayName: 'Bob Panel Run',
    application: 'BobIntegration',
    sourceQueue: 'bobRunQueue',
  },
  {
    label: 'libreoncology-audio-render',
    displayName: 'LibreOncology Audio Render',
    application: 'LibreOncologyIntegration',
    sourceQueue: 'libreoncologyAudioRenderQueue',
  },
  {
    label: 'data-lake-cleanup',
    displayName: 'Data Lake Cleanup',
    application: 'DataLakeManagement',
    sourceQueue: 'dataLakeCleanupQueue',
  },
  {
    label: 'data-lake-taxonomy',
    displayName: 'Data Lake Taxonomy Analysis',
    application: 'DataLakeManagement',
    sourceQueue: 'dataLakeTaxonomyQueue',
  },
  {
    label: 'lake-memory',
    displayName: 'Lake Memory Extraction',
    application: 'DataLakeManagement',
    sourceQueue: 'lakeMemoryQueue',
  },
  {
    label: 'risk-evidence',
    displayName: 'Account Risk Evidence',
    application: 'Signup',
    sourceQueue: 'riskEvidenceQueue',
  },
  {
    label: 'lake-inconsistency-model',
    displayName: 'Lake Model Inconsistency Detection',
    application: 'DataLakeManagement',
    sourceQueue: 'lakeInconsistencyModelQueue',
  },
  {
    label: 'drive-lake-ingest',
    displayName: 'Drive Lake Ingest',
    application: 'DataLakeManagement',
    sourceQueue: 'driveLakeIngestQueue',
  },
  {
    label: 'drive-disconnect-purge',
    displayName: 'Drive Disconnect Purge',
    application: 'DataLakeManagement',
    sourceQueue: 'driveDisconnectPurgeQueue',
  },
  {
    label: 'github-lake-ingest',
    displayName: 'GitHub Lake Ingest',
    application: 'DataLakeManagement',
    sourceQueue: 'githubLakeIngestQueue',
  },
  {
    label: 'github-lake-revoke',
    displayName: 'GitHub Lake Revoke',
    application: 'DataLakeManagement',
    sourceQueue: 'githubLakeRevokeQueue',
  },
  {
    label: 'publish-thumbnail',
    displayName: 'Published Artifact Thumbnail',
    application: 'PublishedArtifacts',
    sourceQueue: 'publishThumbnailQueue',
  },
  {
    label: 'young-account-spend-alert',
    displayName: 'Young Account Spend Alert',
    application: 'Signup',
    sourceQueue: null,
    replay: 'unsafe',
  },
  {
    label: 'api-probe-detector',
    displayName: 'API Probe Detector',
    application: 'Security',
    sourceQueue: null,
    replay: 'unsafe',
  },
  {
    label: 'image-moderation-review-sweep',
    displayName: 'Image Moderation Review Sweep',
    application: 'Moderation',
    sourceQueue: null,
    replay: 'unsafe',
  },
  {
    label: 'spend-monitor',
    displayName: 'Spend Monitor',
    application: 'Billing',
    sourceQueue: null,
    replay: 'unsafe',
  },
  {
    label: 'signup-grant-held-release',
    displayName: 'Signup Grant Held Release',
    application: 'Signup',
    sourceQueue: null,
    replay: 'unsafe',
  },
  {
    label: 'revenue-snapshot',
    displayName: 'Revenue Snapshot',
    application: 'Billing',
    sourceQueue: null,
    replay: 'unsafe',
  },
  {
    label: 'subscription-reconciliation',
    displayName: 'Subscription Reconciliation',
    application: 'Billing',
    sourceQueue: null,
    replay: 'unsafe',
  },
  {
    label: 'account-deletion-sweep',
    displayName: 'Account Deletion Sweep',
    application: 'Account',
    sourceQueue: null,
    replay: 'unsafe',
  },
  {
    label: 'fab-file-moderation',
    displayName: 'FabFile Moderation',
    application: 'FabFileProcessing',
    sourceQueue: null,
    replay: 'unsafe',
  },
  {
    label: 'telemetry-alert-rule',
    displayName: 'Telemetry Alert Rule',
    application: 'TelemetryAlerts',
    sourceQueue: null,
    replay: 'unsafe',
  },
  {
    label: 'session-enrichment',
    displayName: 'Session Enrichment',
    application: 'SessionEnrichment',
    sourceQueue: null,
    replay: 'unsafe',
  },
  {
    label: 'billing-events',
    displayName: 'Billing Events',
    application: 'Billing',
    sourceQueue: null,
    replay: 'unsafe',
  },
  {
    label: 'email-events',
    displayName: 'Email Events',
    application: 'Email',
    sourceQueue: null,
    replay: 'unsafe',
  },
  {
    label: 'push-events',
    displayName: 'Push Events',
    application: 'Notifications',
    sourceQueue: null,
    replay: 'unsafe',
  },
  {
    label: 'notebook-events',
    displayName: 'Notebook Events',
    application: 'NotebookCuration',
    sourceQueue: null,
    replay: 'unsafe',
  },
  {
    label: 'completion-events',
    displayName: 'Completion Events',
    application: 'Completions',
    sourceQueue: null,
    replay: 'unsafe',
  },
  {
    label: 'business-metric-alerts',
    displayName: 'Business Metric Alerts',
    application: 'Analytics',
    sourceQueue: null,
    replay: 'unsafe',
  },
  {
    label: 'alarm-handler',
    displayName: 'DLQ Alarm Handler',
    application: 'AlarmPipeline',
    sourceQueue: null,
    replay: 'unsafe',
  },
] as const satisfies readonly DlqDescriptor[];

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
export type RegisteredDlqDescriptor = DlqDescriptor & { label: DlqLabel; sourceQueue: SourceQueueName | null };

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

let registry: ReturnType<typeof createDlqRegistry<readonly DlqDescriptor[]>> | undefined;
const contributedLabels = new Set<string>();
const contributedSourceQueues = new Set<string>();

function getRegistry() {
  if (!registry) {
    const contributed = contributedDescriptors();
    for (const d of contributed) {
      contributedLabels.add(d.label);
      if (d.sourceQueue !== null) contributedSourceQueues.add(d.sourceQueue);
    }
    registry = createDlqRegistry<readonly DlqDescriptor[]>([...DLQ_REGISTRY, ...contributed], resolvers, {
      dlqErrorContext: 'Check dlqUrls Linkable in infra/web.ts.',
      sourceQueueErrorContext: 'Check sourceQueueUrls Linkable in infra/web.ts.',
    });
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

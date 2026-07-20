import { Resource } from 'sst';
import { createDlqRegistry } from '@bike4mind/infra';
import type { DlqDescriptor, DlqResolvers } from '@bike4mind/infra';

/**
 * SQS queue URLs are stored via sst.Linkable in resource.enc.
 * This avoids both IAM inline policy bloat (from SST queue links) and
 * env var size limits. The wildcard SQS permission already covers access.
 */

/**
 * Runtime registry of all DLQ->source queue pairs.
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
    label: 'research-engine',
    displayName: 'Research Engine',
    application: 'ResearchEngine',
    sourceQueue: 'researchEngineQueue',
  },
  {
    label: 'whats-new-generation',
    displayName: "What's New Generation",
    application: 'WhatsNewGeneration',
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
    label: 'video-generation',
    displayName: 'Video Generation',
    application: 'VideoGeneration',
    sourceQueue: 'videoGenerationQueue',
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
    label: 'data-lake-cleanup',
    displayName: 'Data Lake Cleanup',
    application: 'DataLakeManagement',
    sourceQueue: 'dataLakeCleanupQueue',
  },
] as const satisfies readonly DlqDescriptor[];

/** Valid source queue names - derived from DLQ_REGISTRY so they stay in sync automatically. */
export type SourceQueueName = (typeof DLQ_REGISTRY)[number]['sourceQueue'];

type LinkableQueues = {
  dlqUrls: Record<string, string>;
  sourceQueueUrls: Record<SourceQueueName, string>;
};

const resolvers: DlqResolvers = {
  resolveDlqUrl: label => (Resource as unknown as LinkableQueues).dlqUrls?.[label],
  resolveSourceQueueUrl: name => (Resource as unknown as LinkableQueues).sourceQueueUrls?.[name as SourceQueueName],
};

const registry = createDlqRegistry(DLQ_REGISTRY, resolvers, {
  dlqErrorContext: 'Check dlqUrls Linkable in infra/web.ts.',
  sourceQueueErrorContext: 'Check sourceQueueUrls Linkable in infra/web.ts.',
});

export function getDlqRegistry() {
  return registry.getAllDescriptors();
}

export function getDlqByLabel(label: string) {
  return registry.getDlqByLabel(label as (typeof DLQ_REGISTRY)[number]['label']);
}

export function getDlqUrl(label: (typeof DLQ_REGISTRY)[number]['label']): string {
  return registry.getDlqUrl(label);
}

/**
 * Get a source queue URL from the sourceQueueUrls Linkable.
 * Exported for use by queue handlers, API routes, and cron jobs.
 */
export function getSourceQueueUrl(name: SourceQueueName): string {
  return registry.getSourceQueueUrl(name);
}

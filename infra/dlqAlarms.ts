/**
 * DLQ Health Monitoring - Alarms and Dashboard
 *
 * Unified monitoring for all 28 Dead Letter Queues across the application.
 * Uses a single shared SNS topic for all DLQ alarm notifications.
 *
 * Default alarm thresholds (per-queue overrides available via DlqDescriptor):
 * - Message count: sustained activity detection — must breach threshold (> 0)
 *   for 3 consecutive 60s evaluation periods (3 min) before firing
 * - Message age: any message older than 1 hour (3600s) triggers alarm
 *   (single evaluation period — the 1hr threshold already provides built-in delay)
 *
 * Stage-gated: Only deployed to `dev` and `production` stages.
 * Set ENABLE_MONITORING=true to opt in for other stages.
 */

import { secrets } from './secrets';
import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import {
  fabFileVectorizeQueueDLQ,
  fabFileChunkQueueDLQ,
  fabFileModerationDLQ,
  imageGenerationDLQ,
  imageEditDLQ,
  researchEngineQueueDLQ,
  whatsNewGenerationQueueDLQ,
  whatsNewHighlightsQueueDLQ,
  notebookCurationQueueDLQ,
  agentProactiveMessageQueueDLQ,
  githubWebhookQueueDLQ,
  webhookDeliveryQueueDLQ,
  slackExportQueueDLQ,
  questExportQueueDLQ,
  dataLakeCleanupQueueDLQ,
  videoGenerationDLQ,
  liveOpsTriageQueueDLQ,
  tavernHeartbeatQueueDLQ,
  deepAgentWakeQueueDLQ,
  sreFixQueueDLQ,
  sreJobQueueDLQ,
  secopsTriageQueueDLQ,
  overwatchAnalyticsQueueDLQ,
  agentContinuationQueueDLQ,
  optihashiRunCompletionQueueDLQ,
  bobRunQueueDLQ,
} from './queues';
import { telemetryAlertRuleDLQ } from './eventBus';
import { emailIngestionQueueDLQ, emailAnalysisQueueDLQ } from './emailIngestion';
import { emailBatchQueueDLQ, emailJobQueueDLQ } from './emailMarketing';
import { isMonitoredStage as _isMonitoredStage, buildDlqAlarmSpecs } from '@bike4mind/infra';
import type { DlqDescriptor } from '@bike4mind/infra';

const MONITORED_STAGES = ['dev', 'production'] as const;
const isMonitoredStage = _isMonitoredStage($app.stage, MONITORED_STAGES, process.env.ENABLE_MONITORING);

/**
 * Shared SNS topic for all DLQ alarm notifications.
 * Subscribe once to receive alerts from all 28 DLQs.
 */
export const dlqAlarmTopic = isMonitoredStage ? new sst.aws.SnsTopic('DlqAlarmTopic') : undefined;

/**
 * Wire DLQ alarm SNS topic → Slack.
 * Only ALARM state transitions are forwarded; OK (resolved) events are suppressed.
 */
if (isMonitoredStage) {
  const dlqAlarmHandlerDlq = new aws.sqs.Queue('DlqAlarmHandlerDlq', {
    messageRetentionSeconds: 14 * 24 * 3600,
  });

  // Policy not captured — SST's subscribe() has no dependsOn surface, so explicit sequencing
  // isn't achievable here. SNS validates DLQ permissions lazily on first SendMessage, not at
  // subscribe time, so convergence order is safe in practice.
  new aws.sqs.QueuePolicy('DlqAlarmHandlerDlqPolicy', {
    queueUrl: dlqAlarmHandlerDlq.url,
    policy: $util.all([dlqAlarmHandlerDlq.arn, dlqAlarmTopic!.arn]).apply(([dlqArn, topicArn]) =>
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'sns.amazonaws.com' },
            Action: 'sqs:SendMessage',
            Resource: dlqArn,
            Condition: { ArnEquals: { 'aws:SourceArn': topicArn } },
          },
        ],
      })
    ),
  });

  dlqAlarmTopic!.subscribe(
    {
      handler: 'apps/client/server/events/dlqAlarmToSlack.handler',
      link: [secrets.SLACK_ERROR_REPORTING_WEBHOOK_URL],
      environment: { ...DEFAULT_LAMBDA_ENVIRONMENT },
      logging: { retention: '3 days' },
    },
    {
      transform: {
        subscription: {
          redrivePolicy: dlqAlarmHandlerDlq.arn.apply(arn => JSON.stringify({ deadLetterTargetArn: arn })),
        },
      },
    }
  );
}

type InfraDlqDescriptor = DlqDescriptor & {
  /** The sst.aws.Queue resource for this DLQ */
  queue: sst.aws.Queue;
  /** Override message count alarm evaluation periods (default: 3) */
  messageEvalPeriods?: number;
  /** Override message count alarm threshold (default: 0) */
  messageThreshold?: number;
  /** Override message age alarm threshold in seconds (default: 3600) */
  ageThreshold?: number;
};

// ⚠️  SYNC WARNING: When adding/removing a DLQ here, also update
// DLQ_REGISTRY in apps/client/server/utils/dlqRegistry.ts to keep the admin replay UI in sync.
// Drift is caught automatically by dlqRegistrySync.test.ts.
const DLQ_DESCRIPTORS: InfraDlqDescriptor[] = [
  // queues.ts DLQs
  {
    label: 'fab-file-vectorize',
    displayName: 'FabFile Vectorize',
    application: 'FabFileProcessing',
    sourceQueue: 'fabFileVectorizeQueue',
    queue: fabFileVectorizeQueueDLQ,
  },
  {
    label: 'fab-file-chunk',
    displayName: 'FabFile Chunk',
    application: 'FabFileProcessing',
    sourceQueue: 'fabFileChunkQueue',
    queue: fabFileChunkQueueDLQ,
  },
  {
    label: 'image-generation',
    displayName: 'Image Generation',
    application: 'ImageGeneration',
    sourceQueue: 'imageGenerationQueue',
    queue: imageGenerationDLQ,
  },
  {
    label: 'image-edit',
    displayName: 'Image Edit',
    application: 'ImageGeneration',
    sourceQueue: 'imageEditQueue',
    queue: imageEditDLQ,
  },
  {
    label: 'research-engine',
    displayName: 'Research Engine',
    application: 'ResearchEngine',
    sourceQueue: 'researchEngineQueue',
    queue: researchEngineQueueDLQ,
  },
  {
    label: 'whats-new-generation',
    displayName: "What's New Generation",
    application: 'WhatsNewGeneration',
    sourceQueue: 'whatsNewGenerationQueue',
    queue: whatsNewGenerationQueueDLQ,
  },
  {
    label: 'whats-new-highlights',
    displayName: "What's New Highlights",
    application: 'WhatsNewGeneration',
    sourceQueue: 'whatsNewHighlightsQueue',
    queue: whatsNewHighlightsQueueDLQ,
  },
  {
    label: 'notebook-curation',
    displayName: 'Notebook Curation',
    application: 'NotebookCuration',
    sourceQueue: 'notebookCurationQueue',
    queue: notebookCurationQueueDLQ,
  },
  {
    label: 'agent-proactive-message',
    displayName: 'Agent Proactive Message',
    application: 'AgentMessaging',
    sourceQueue: 'agentProactiveMessageQueue',
    queue: agentProactiveMessageQueueDLQ,
  },
  {
    label: 'github-webhook',
    displayName: 'GitHub Webhook',
    application: 'GitHubWebhooks',
    sourceQueue: 'githubWebhookQueue',
    queue: githubWebhookQueueDLQ,
  },
  {
    label: 'webhook-delivery',
    displayName: 'Webhook Delivery',
    application: 'WebhookDelivery',
    sourceQueue: 'webhookDeliveryQueue',
    queue: webhookDeliveryQueueDLQ,
  },
  {
    label: 'slack-export',
    displayName: 'Slack Export',
    application: 'SlackExport',
    sourceQueue: 'slackExportQueue',
    queue: slackExportQueueDLQ,
  },
  {
    label: 'quest-export',
    displayName: 'Quest Export',
    application: 'QuestExport',
    sourceQueue: 'questExportQueue',
    queue: questExportQueueDLQ,
  },
  {
    label: 'data-lake-cleanup',
    displayName: 'Data Lake Cleanup',
    application: 'DataLakeManagement',
    sourceQueue: 'dataLakeCleanupQueue',
    queue: dataLakeCleanupQueueDLQ,
  },
  {
    label: 'video-generation',
    displayName: 'Video Generation',
    application: 'VideoGeneration',
    sourceQueue: 'videoGenerationQueue',
    queue: videoGenerationDLQ,
  },
  {
    label: 'liveops-triage',
    displayName: 'LiveOps Triage',
    application: 'LiveOpsTriage',
    sourceQueue: 'liveOpsTriageQueue',
    queue: liveOpsTriageQueueDLQ,
  },
  // SRE Agent DLQs
  {
    label: 'sre-fix',
    displayName: 'SRE Fix',
    application: 'SreAgent',
    sourceQueue: 'sreFixQueue',
    queue: sreFixQueueDLQ,
  },
  {
    label: 'sre-job',
    displayName: 'SRE Job',
    application: 'SreAgent',
    sourceQueue: 'sreJobQueue',
    queue: sreJobQueueDLQ,
  },
  // emailIngestion.ts DLQs
  {
    label: 'email-ingestion',
    displayName: 'Email Ingestion',
    application: 'EmailIngestion',
    sourceQueue: 'emailIngestionQueue',
    queue: emailIngestionQueueDLQ,
  },
  {
    label: 'email-analysis',
    displayName: 'Email Analysis',
    application: 'EmailIngestion',
    sourceQueue: 'emailAnalysisQueue',
    queue: emailAnalysisQueueDLQ,
  },
  // emailMarketing.ts DLQs
  {
    label: 'email-batch',
    displayName: 'Email Batch',
    application: 'EmailMarketing',
    sourceQueue: 'emailBatchQueue',
    queue: emailBatchQueueDLQ,
  },
  {
    label: 'email-job',
    displayName: 'Email Job',
    application: 'EmailMarketing',
    sourceQueue: 'emailJobQueue',
    queue: emailJobQueueDLQ,
  },
  // queues.ts - tavern
  {
    label: 'tavern-heartbeat',
    displayName: 'Tavern Heartbeat',
    application: 'TavernHeartbeat',
    sourceQueue: 'tavernHeartbeatQueue',
    queue: tavernHeartbeatQueueDLQ,
  },
  // queues.ts - deep agent
  {
    label: 'deep-agent-wake',
    displayName: 'Deep Agent Wake',
    application: 'DeepAgent',
    sourceQueue: 'deepAgentWakeQueue',
    queue: deepAgentWakeQueueDLQ,
  },
  // queues.ts - secops
  {
    label: 'secops-triage',
    displayName: 'SecOps Triage',
    application: 'SecOpsTriage',
    sourceQueue: 'secopsTriageQueue',
    queue: secopsTriageQueueDLQ,
  },
  // queues.ts - overwatch
  {
    label: 'overwatch-analytics',
    displayName: 'Overwatch Analytics',
    application: 'OverwatchAnalytics',
    sourceQueue: 'overwatchAnalyticsQueue',
    queue: overwatchAnalyticsQueueDLQ,
  },
  // queues.ts - agent executor
  {
    label: 'agent-continuation',
    displayName: 'Agent Continuation',
    application: 'AgentExecutor',
    sourceQueue: 'agentContinuationQueue',
    queue: agentContinuationQueueDLQ,
  },
  // queues.ts - optihashi integration
  {
    label: 'optihashi-run-completion',
    displayName: 'OptiHashi Run Completion',
    application: 'OptiHashiIntegration',
    sourceQueue: 'optihashiRunCompletionQueue',
    queue: optihashiRunCompletionQueueDLQ,
  },
  // queues.ts - Bob panel run (@bike4mind/premium-bob, issue #33 step B)
  {
    label: 'bob-run',
    displayName: 'Bob Panel Run',
    application: 'BobIntegration',
    sourceQueue: 'bobRunQueue',
    queue: bobRunQueueDLQ,
  },
];

// --- Alarm creation ---

/**
 * Creates the standard pair of CloudWatch alarms (message count + message age) for a DLQ,
 * wired to the shared dlqAlarmTopic. Shared by the DLQ_DESCRIPTORS loop below and by any
 * alarm-only DLQ (one with no DLQ_REGISTRY/admin-replay counterpart — see fabFileModerationDLQ).
 * `sourceQueue` is omitted: this function only alarms on the DLQ itself and never needs it.
 */
function createDlqAlarms(dlq: Omit<InfraDlqDescriptor, 'sourceQueue'>) {
  // Alarm names, thresholds, and tags come from the shared spec builder; only the
  // resource-bound pieces (queue dimensions, SNS actions) are wired here.
  for (const spec of buildDlqAlarmSpecs(dlq, { appName: $app.name, stage: $app.stage })) {
    new aws.cloudwatch.MetricAlarm(spec.resourceName, {
      ...spec.args,
      dimensions: { QueueName: dlq.queue.nodes.queue.name },
      alarmActions: [dlqAlarmTopic!.arn],
      okActions: [dlqAlarmTopic!.arn],
    });
  }
}

if (isMonitoredStage) {
  for (const dlq of DLQ_DESCRIPTORS) {
    createDlqAlarms(dlq);
  }

  // FabFile Moderation DLQ — deliberately NOT added to DLQ_DESCRIPTORS above.
  // It backs apps/client/server/s3/objectCreated's Lambda async-invocation dead-letter
  // target (see infra/queues.ts), not an sst.aws.Queue `.subscribe()` consumer. Every
  // DLQ_DESCRIPTORS entry has a `sourceQueue` that DLQ_REGISTRY (apps/client/server/utils/
  // dlqRegistry.ts) resolves to a real SQS queue URL for the admin "replay" UI — but this
  // DLQ has no such source: S3 invokes the Lambda directly, so there is no queue to replay
  // a recovered message into. Adding a fake `sourceQueue` would either break
  // dlqRegistrySync.test.ts's DLQ_DESCRIPTORS/DLQ_REGISTRY parity check or wire a
  // non-functional "Replay" button into the admin UI. Ops still gets full alarm coverage
  // via this standalone call.
  createDlqAlarms({
    label: 'fab-file-moderation',
    displayName: 'FabFile Moderation',
    application: 'FabFileProcessing',
    queue: fabFileModerationDLQ,
  });

  // Telemetry Alert rule DLQ - alarm-only for the same reason as fabFileModerationDLQ:
  // it backs the EventBridge telemetry-alert rule target (see infra/eventBus.ts), not an
  // sst.aws.Queue `.subscribe()` consumer, so there is no source queue for the admin
  // "replay" UI to re-enqueue into (recovery is re-emitting the event onto the bus).
  createDlqAlarms({
    label: 'telemetry-alert-rule',
    displayName: 'Telemetry Alert Rule',
    application: 'TelemetryAlerts',
    queue: telemetryAlertRuleDLQ,
  });
}

// --- Dashboard ---

export let dlqHealthDashboard: aws.cloudwatch.Dashboard | undefined;

if (isMonitoredStage) {
  const dlqNames = DLQ_DESCRIPTORS.map(d => d.queue.nodes.queue.name);

  const dashboardBody = $util
    .all([$util.all(dlqNames), aws.getRegionOutput().name, aws.getCallerIdentityOutput().accountId])
    .apply(([names, region, accountId]) => {
      const alarmArns = DLQ_DESCRIPTORS.flatMap(d => [
        `arn:aws:cloudwatch:${region}:${accountId}:alarm:${$app.name}-${$app.stage}-dlq-${d.label}-messages`,
        `arn:aws:cloudwatch:${region}:${accountId}:alarm:${$app.name}-${$app.stage}-dlq-${d.label}-age`,
      ]);

      const widgets: Record<string, unknown>[] = [
        // Row 0: Alarm Status Overview
        {
          type: 'alarm',
          x: 0,
          y: 0,
          width: 24,
          height: 4,
          properties: {
            title: 'DLQ Health Overview - All Queues',
            alarms: alarmArns,
          },
        },
      ];

      // Per-DLQ metric widgets: 2 per row, message count + age on dual Y axes
      DLQ_DESCRIPTORS.forEach((dlq, idx) => {
        const queueName = names[idx];
        const row = Math.floor(idx / 2);
        const col = idx % 2;
        const y = 4 + row * 6;

        widgets.push({
          type: 'metric',
          x: col * 12,
          y,
          width: 12,
          height: 6,
          properties: {
            title: `${dlq.displayName} DLQ`,
            metrics: [
              [
                'AWS/SQS',
                'ApproximateNumberOfMessagesVisible',
                'QueueName',
                queueName,
                { stat: 'Maximum', label: 'Messages Visible', color: '#d62728' },
              ],
              [
                'AWS/SQS',
                'ApproximateAgeOfOldestMessage',
                'QueueName',
                queueName,
                { stat: 'Maximum', label: 'Oldest Message Age (s)', yAxis: 'right', color: '#ff7f0e' },
              ],
            ],
            view: 'timeSeries',
            stacked: false,
            region,
            period: 60,
            yAxis: {
              left: { min: 0, label: 'Message Count' },
              right: { min: 0, label: 'Age (seconds)' },
            },
            annotations: {
              horizontal: [{ value: 3600, label: '1 Hour Threshold', yAxis: 'right', fill: 'above' }],
            },
          },
        });
      });

      return JSON.stringify({ widgets });
    });

  dlqHealthDashboard = new aws.cloudwatch.Dashboard('DlqHealthDashboard', {
    dashboardName: `${$app.name}-${$app.stage}-dlq-health`,
    dashboardBody,
  });
}

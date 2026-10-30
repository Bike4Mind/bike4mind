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
 * - Missing data: 'ignore', which holds the current state, so a range with no SQS datapoint
 *   cannot resolve a firing alarm to OK and re-page on the next point. The age alarms score
 *   IF(visible > 0, age, 0) because SQS stops publishing the age metric on an empty queue;
 *   the known residuals are documented at the age alarms below.
 *
 * Stage-gated: Only deployed to `dev` and `production` stages.
 * Set ENABLE_MONITORING=true to opt in for other stages.
 */

import { secrets } from './secrets';
import { alarmSlackMentionFunctionArgs } from './alarmSlackMention';
import { businessMetricAlertsDLQ } from './businessMetricAlerts';
import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import {
  fabFileVectorizeQueueDLQ,
  fabFileChunkQueueDLQ,
  fabFileModerationDLQ,
  imageGenerationDLQ,
  imageEditDLQ,
  generationCallbackQueueDLQ,
  researchEngineQueueDLQ,
  whatsNewGenerationQueueDLQ,
  whatsNewHighlightsQueueDLQ,
  notebookCurationQueueDLQ,
  agentProactiveMessageQueueDLQ,
  githubWebhookQueueDLQ,
  webhookDeliveryQueueDLQ,
  slackExportQueueDLQ,
  questExportQueueDLQ,
  publishThumbnailQueueDLQ,
  dataLakeCleanupQueueDLQ,
  dataLakeTaxonomyQueueDLQ,
  dataLakeResearchQueueDLQ,
  lakeMemoryQueueDLQ,
  lakeInconsistencyModelQueueDLQ,
  driveLakeIngestQueueDLQ,
  driveDisconnectPurgeQueueDLQ,
  githubLakeIngestQueueDLQ,
  githubLakeRevokeQueueDLQ,
  generationJobDLQ,
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
  libreoncologyAudioRenderQueueDLQ,
  contributedQueues,
} from './queues';
import {
  telemetryAlertDeadLetter,
  sessionEnrichmentDeadLetter,
  billingEventsDeadLetter,
  emailEventsDeadLetter,
  notebookEventsDeadLetter,
  completionEventsDeadLetter,
} from './eventBus';
import { emailIngestionQueueDLQ, emailAnalysisQueueDLQ } from './emailIngestion';
import { emailBatchQueueDLQ, emailJobQueueDLQ } from './emailMarketing';
import {
  isMonitoredStage as _isMonitoredStage,
  bindDlqAlarmDimensions,
  buildDlqAgeMetricQueries,
  buildDlqAlarmSpecs,
} from '@bike4mind/infra';
import type { DlqDescriptor } from '@bike4mind/infra';
import { youngAccountSpendAlertDeadLetter } from './youngAccountSpendAlertDeadLetter';
import { spendMonitorDeadLetter } from './spendMonitorDeadLetter';
import { signupGrantHeldReleaseDeadLetter } from './signupGrantHeldReleaseDeadLetter';

const MONITORED_STAGES = ['dev', 'production'] as const;
const isMonitoredStage = _isMonitoredStage($app.stage, MONITORED_STAGES, process.env.ENABLE_MONITORING);

/**
 * Shared SNS topic for all DLQ alarm notifications.
 * Subscribe once to receive alerts from all 28 DLQs.
 */
export const dlqAlarmTopic = isMonitoredStage ? new sst.aws.SnsTopic('DlqAlarmTopic') : undefined;

/** Email-only topic (OPS_ALERT_EMAIL) that does not depend on the Slack forwarding Lambda. */
export const oobAlarmTopic = isMonitoredStage ? new sst.aws.SnsTopic('OobAlarmTopic') : undefined;

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

  const mentionArgs = alarmSlackMentionFunctionArgs();
  dlqAlarmTopic!.subscribe(
    {
      handler: 'apps/workers/src/events/dlqAlarmToSlack.handler',
      link: [secrets.SLACK_ERROR_REPORTING_WEBHOOK_URL, secrets.SLACK_ALARMS_WEBHOOK_URL],
      environment: { ...DEFAULT_LAMBDA_ENVIRONMENT, ...mentionArgs.environment },
      permissions: mentionArgs.permissions,
    },
    {
      transform: {
        subscription: {
          redrivePolicy: dlqAlarmHandlerDlq.arn.apply(arn => JSON.stringify({ deadLetterTargetArn: arn })),
        },
      },
    }
  );

  // Out-of-band alarm for DlqAlarmHandlerDlq itself.
  // Cannot route to dlqAlarmTopic -- that would loop into the same failing Lambda.
  // Routes to a dedicated SNS topic with a direct email subscription instead.
  // NOTE: after the first deploy, check your inbox for an SNS confirmation email and click
  // the link -- subscriptions stay in PendingConfirmation and deliver nothing until confirmed.
  if (process.env.OPS_ALERT_EMAIL) {
    // retainOnDelete: the AWS provider cannot destroy a PendingConfirmation subscription.
    // If OPS_ALERT_EMAIL is unset on a later deploy before the confirmation link is clicked,
    // retain the resource in AWS rather than leaving a dangling subscription outside state.
    // Note: rotating OPS_ALERT_EMAIL is a replace (endpoint is force-new), so the old
    // subscription is retained rather than unsubscribed -- manually unsubscribe the old
    // endpoint from the SNS console after any address change.
    new aws.sns.TopicSubscription(
      'OobAlarmTopicEmailSub',
      {
        topic: oobAlarmTopic!.arn,
        protocol: 'email',
        endpoint: process.env.OPS_ALERT_EMAIL,
      },
      { retainOnDelete: true }
    );
  } else {
    console.warn(
      `[WARN] OPS_ALERT_EMAIL is unset on stage '${$app.stage}'. ` +
        `OobAlarmTopic will be created with no subscriber -- DlqAlarmHandlerDlq alarms ` +
        `will publish into the void. Set OPS_ALERT_EMAIL in the deploy pipeline variables.`
    );
  }

  // Message-count alarm: any message in the DLQ means the Slack Lambda is failing.
  // evaluationPeriods: 1 is intentional -- any DLQ message here is an immediate failure
  // signal, not transient noise, so a single breaching period is the right sensitivity.
  new aws.cloudwatch.MetricAlarm('DlqAlarmHandlerDlqMessages', {
    name: `${$app.name}-${$app.stage}-dlq-alarm-handler-dlq-messages`,
    alarmDescription:
      'DlqAlarmHandlerDlq has messages -- the alarm-to-Slack Lambda is failing; check SLACK_ALARMS_WEBHOOK_URL, SLACK_ERROR_REPORTING_WEBHOOK_URL and Lambda errors.',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'ApproximateNumberOfMessagesVisible',
    namespace: 'AWS/SQS',
    period: 60,
    statistic: 'Maximum',
    threshold: 0,
    treatMissingData: 'ignore',
    dimensions: { QueueName: dlqAlarmHandlerDlq.name },
    alarmActions: [oobAlarmTopic!.arn],
    tags: { Application: 'AlarmPipeline', Severity: 'Critical', MonitoringType: 'DLQ' },
  });

  // Age alarm: same 1-hour threshold as the standard DLQ fleet. period is 60s (vs fleet
  // 300s) to match the message-count alarm above and keep both alarms on the same cadence.
  new aws.cloudwatch.MetricAlarm('DlqAlarmHandlerDlqAge', {
    name: `${$app.name}-${$app.stage}-dlq-alarm-handler-dlq-age`,
    alarmDescription:
      'DlqAlarmHandlerDlq oldest message exceeds 1 hour -- the alarm-to-Slack Lambda has been failing for an extended period.',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    threshold: 3600,
    treatMissingData: 'ignore',
    // Same IF(visible > 0, age, 0) metric math as the fleet age alarms; see
    // b4m-core/infra/src/dlqAlarmSpecs.ts for why and its residuals.
    metricQueries: buildDlqAgeMetricQueries(60, { QueueName: dlqAlarmHandlerDlq.name }),
    alarmActions: [oobAlarmTopic!.arn],
    tags: { Application: 'AlarmPipeline', Severity: 'High', MonitoringType: 'DLQ' },
  });
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
// DLQ_REGISTRY in packages/server-utils/src/utils/dlqRegistry.ts to keep the admin replay UI in sync.
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
    label: 'generation-callback',
    displayName: 'Generation Callback',
    application: 'ImageGeneration',
    sourceQueue: 'generationCallbackQueue',
    queue: generationCallbackQueueDLQ,
  },
  {
    label: 'research-engine',
    displayName: 'Research Engine',
    application: 'ResearchEngine',
    sourceQueue: 'researchEngineQueue',
    queue: researchEngineQueueDLQ,
  },
  {
    label: 'release-notes',
    displayName: 'Release Notes',
    application: 'ReleaseNotes',
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
    label: 'data-lake-taxonomy',
    displayName: 'Data Lake Taxonomy Analysis',
    application: 'DataLakeManagement',
    sourceQueue: 'dataLakeTaxonomyQueue',
    queue: dataLakeTaxonomyQueueDLQ,
  },
  {
    label: 'data-lake-research',
    displayName: 'Data Lake Research Run',
    application: 'DataLakeManagement',
    sourceQueue: 'dataLakeResearchQueue',
    queue: dataLakeResearchQueueDLQ,
  },
  {
    label: 'lake-memory',
    displayName: 'Lake Memory Extraction',
    application: 'DataLakeManagement',
    sourceQueue: 'lakeMemoryQueue',
    queue: lakeMemoryQueueDLQ,
  },
  {
    label: 'lake-inconsistency-model',
    displayName: 'Lake Model Inconsistency Detection',
    application: 'DataLakeManagement',
    sourceQueue: 'lakeInconsistencyModelQueue',
    queue: lakeInconsistencyModelQueueDLQ,
  },
  {
    label: 'drive-lake-ingest',
    displayName: 'Drive Lake Ingest',
    application: 'DataLakeManagement',
    sourceQueue: 'driveLakeIngestQueue',
    queue: driveLakeIngestQueueDLQ,
  },
  {
    label: 'drive-disconnect-purge',
    displayName: 'Drive Disconnect Purge',
    application: 'DataLakeManagement',
    sourceQueue: 'driveDisconnectPurgeQueue',
    queue: driveDisconnectPurgeQueueDLQ,
  },
  {
    label: 'github-lake-ingest',
    displayName: 'GitHub Lake Ingest',
    application: 'DataLakeManagement',
    sourceQueue: 'githubLakeIngestQueue',
    queue: githubLakeIngestQueueDLQ,
  },
  {
    label: 'github-lake-revoke',
    displayName: 'GitHub Lake Revoke',
    application: 'DataLakeManagement',
    sourceQueue: 'githubLakeRevokeQueue',
    queue: githubLakeRevokeQueueDLQ,
  },
  {
    label: 'publish-thumbnail',
    displayName: 'Published Artifact Thumbnail',
    application: 'PublishedArtifacts',
    sourceQueue: 'publishThumbnailQueue',
    queue: publishThumbnailQueueDLQ,
  },
  {
    label: 'generation-job',
    displayName: 'Generation Job',
    application: 'GenerationJob',
    sourceQueue: 'generationJobQueue',
    queue: generationJobDLQ,
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
  // queues.ts - LibreOncology mock-oral audio render (@bike4mind/premium-libreoncology)
  {
    label: 'libreoncology-audio-render',
    displayName: 'LibreOncology Audio Render',
    application: 'LibreOncologyIntegration',
    sourceQueue: 'libreoncologyAudioRenderQueue',
    queue: libreoncologyAudioRenderQueueDLQ,
  },
];

// Contributed pairs follow the core descriptors, so adding one appends dashboard widgets
// rather than moving the existing ones.
const ALARMED_DLQS: InfraDlqDescriptor[] = [
  ...DLQ_DESCRIPTORS,
  ...Object.values(contributedQueues).map(({ spec, dlq }) => ({
    label: spec.label,
    displayName: spec.displayName,
    application: spec.application,
    sourceQueue: spec.name,
    queue: dlq,
  })),
];

// --- Alarm creation ---

/**
 * Creates the standard pair of CloudWatch alarms (message count + message age) for a DLQ,
 * wired to the shared dlqAlarmTopic. Shared by the ALARMED_DLQS loop below and by any
 * alarm-only DLQ (one with no DLQ_REGISTRY/admin-replay counterpart — see fabFileModerationDLQ).
 * `sourceQueue` is omitted: this function only alarms on the DLQ itself and never needs it.
 */
function createDlqAlarms(dlq: Omit<InfraDlqDescriptor, 'sourceQueue'>) {
  // Alarm names, thresholds, and tags come from the shared spec builder; only the
  // resource-bound pieces (queue dimensions, SNS actions) are wired here.
  const dimensions = { QueueName: dlq.queue.nodes.queue.name };
  for (const spec of buildDlqAlarmSpecs(dlq, { appName: $app.name, stage: $app.stage })) {
    new aws.cloudwatch.MetricAlarm(spec.resourceName, {
      ...spec.args,
      ...bindDlqAlarmDimensions(spec, dimensions),
      alarmActions: [dlqAlarmTopic!.arn],
      okActions: [dlqAlarmTopic!.arn],
    });
  }
}

if (isMonitoredStage) {
  for (const dlq of ALARMED_DLQS) {
    createDlqAlarms(dlq);
  }

  if (youngAccountSpendAlertDeadLetter) {
    createDlqAlarms({
      label: 'young-account-spend-alert',
      displayName: 'Young Account Spend Alert',
      application: 'Signup',
      queue: youngAccountSpendAlertDeadLetter.queue,
    });
  }

  if (spendMonitorDeadLetter) {
    createDlqAlarms({
      label: 'spend-monitor',
      displayName: 'Spend Monitor',
      application: 'Billing',
      queue: spendMonitorDeadLetter.queue,
    });
  }

  if (signupGrantHeldReleaseDeadLetter) {
    createDlqAlarms({
      label: 'signup-grant-held-release',
      displayName: 'Signup Grant Held Release',
      application: 'Signup',
      queue: signupGrantHeldReleaseDeadLetter.queue,
    });
  }

  // FabFile Moderation DLQ — deliberately NOT added to DLQ_DESCRIPTORS above.
  // It backs apps/workers/src/s3/objectCreated's Lambda async-invocation dead-letter
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

  // Event bus dead letters - alarm-only for the same reason: they back EventBridge rule
  // targets and their Lambdas' async-invoke failures, not a queue consumer, so there is no
  // source queue to replay into (see infra/eventBusDeadLetter.ts).
  createDlqAlarms({
    label: 'telemetry-alert-rule',
    displayName: 'Telemetry Alert Rule',
    application: 'TelemetryAlerts',
    queue: telemetryAlertDeadLetter.queue,
  });
  createDlqAlarms({
    label: 'session-enrichment',
    displayName: 'Session Enrichment',
    application: 'SessionEnrichment',
    queue: sessionEnrichmentDeadLetter.queue,
  });
  createDlqAlarms({
    label: 'billing-events',
    displayName: 'Billing Events',
    application: 'Billing',
    queue: billingEventsDeadLetter.queue,
  });
  createDlqAlarms({
    label: 'email-events',
    displayName: 'Email Events',
    application: 'Email',
    queue: emailEventsDeadLetter.queue,
  });
  createDlqAlarms({
    label: 'notebook-events',
    displayName: 'Notebook Events',
    application: 'NotebookCuration',
    queue: notebookEventsDeadLetter.queue,
  });
  createDlqAlarms({
    label: 'completion-events',
    displayName: 'Completion Events',
    application: 'Completions',
    queue: completionEventsDeadLetter.queue,
  });
}

if (businessMetricAlertsDLQ && dlqAlarmTopic) {
  createDlqAlarms({
    label: 'business-metric-alerts',
    displayName: 'Business Metric Alerts',
    application: 'Analytics',
    queue: businessMetricAlertsDLQ,
  });
}

// --- Dashboard ---

export let dlqHealthDashboard: aws.cloudwatch.Dashboard | undefined;

if (isMonitoredStage) {
  const dlqNames = ALARMED_DLQS.map(d => d.queue.nodes.queue.name);

  const dashboardBody = $util
    .all([$util.all(dlqNames), aws.getRegionOutput().name, aws.getCallerIdentityOutput().accountId])
    .apply(([names, region, accountId]) => {
      const alarmArns = ALARMED_DLQS.flatMap(d => [
        `arn:aws:cloudwatch:${region}:${accountId}:alarm:${$app.name}-${$app.stage}-dlq-${d.label}-messages`,
        `arn:aws:cloudwatch:${region}:${accountId}:alarm:${$app.name}-${$app.stage}-dlq-${d.label}-age`,
      ]);
      // Include the OOB alarms for the alarm-pipeline DLQ itself so they appear in the
      // health overview widget alongside the rest of the fleet.
      alarmArns.push(
        `arn:aws:cloudwatch:${region}:${accountId}:alarm:${$app.name}-${$app.stage}-dlq-alarm-handler-dlq-messages`,
        `arn:aws:cloudwatch:${region}:${accountId}:alarm:${$app.name}-${$app.stage}-dlq-alarm-handler-dlq-age`
      );

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
      ALARMED_DLQS.forEach((dlq, idx) => {
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

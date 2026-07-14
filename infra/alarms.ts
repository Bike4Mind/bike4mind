/**
 * CloudWatch Alarms for Application Health Monitoring
 *
 * Monitors operational health for What's New generation, LiveOps triage,
 * webhook delivery, integration health probes, and API rate limits.
 *
 * DLQ-specific alarms are defined separately in dlqAlarms.ts.
 *
 * Stage-gated: Only deployed to `dev` and `production` stages.
 * Set ENABLE_MONITORING=true to opt in for other stages (e.g., PR previews
 * that touch alarm/dashboard code).
 */

import { whatsNewGenerationQueueSubscription, webhookDeliveryQueueSubscription } from './queues';
import { subscribeQueryRoute, unsubscribeQueryRoute } from './subscriberFanout';
import { isMonitoredStage as _isMonitoredStage } from '@bike4mind/infra';

const MONITORED_STAGES = ['dev', 'production'] as const;
const isMonitoredStage = _isMonitoredStage($app.stage, MONITORED_STAGES, process.env.ENABLE_MONITORING);

// --- Conditional SNS topic exports (undefined when not monitored) ---

export const whatsNewFailureAlarm = isMonitoredStage ? new sst.aws.SnsTopic('WhatsNewFailureAlarm') : undefined;

export const whatsNewDurationAlarm = isMonitoredStage ? new sst.aws.SnsTopic('WhatsNewDurationAlarm') : undefined;

export const whatsNewCostAlarm = isMonitoredStage ? new sst.aws.SnsTopic('WhatsNewCostAlarm') : undefined;

export const whatsNewLambdaErrorAlarm = isMonitoredStage ? new sst.aws.SnsTopic('WhatsNewLambdaErrorAlarm') : undefined;

export const anthropicRateLimitAlarm = isMonitoredStage ? new sst.aws.SnsTopic('AnthropicRateLimitAlarm') : undefined;

export const liveopsTriageFailureAlarm = isMonitoredStage
  ? new sst.aws.SnsTopic('LiveOpsTriageFailureAlarm')
  : undefined;

export const liveopsHighErrorVolumeAlarm = isMonitoredStage
  ? new sst.aws.SnsTopic('LiveOpsHighErrorVolumeAlarm')
  : undefined;

export const liveopsP0IssuesAlarm = isMonitoredStage ? new sst.aws.SnsTopic('LiveOpsP0IssuesAlarm') : undefined;

export const liveopsP1IssuesAlarm = isMonitoredStage ? new sst.aws.SnsTopic('LiveOpsP1IssuesAlarm') : undefined;

export const liveopsConsecutiveFailuresAlarm = isMonitoredStage
  ? new sst.aws.SnsTopic('LiveOpsConsecutiveFailuresAlarm')
  : undefined;

export const webhookDeliveryFailureAlarm = isMonitoredStage
  ? new sst.aws.SnsTopic('WebhookDeliveryFailureAlarm')
  : undefined;

export const webhookDeliveryLatencyAlarm = isMonitoredStage
  ? new sst.aws.SnsTopic('WebhookDeliveryLatencyAlarm')
  : undefined;

export const webhookDeliveryLambdaErrorAlarm = isMonitoredStage
  ? new sst.aws.SnsTopic('WebhookDeliveryLambdaErrorAlarm')
  : undefined;

export const rateLimitWarningAlarm = isMonitoredStage ? new sst.aws.SnsTopic('RateLimitWarningAlarm') : undefined;

export const rateLimitHitAlarm = isMonitoredStage ? new sst.aws.SnsTopic('RateLimitHitAlarm') : undefined;

export const integrationHealthSlackFailureAlarm = isMonitoredStage
  ? new sst.aws.SnsTopic('IntegrationHealthSlackFailureAlarm')
  : undefined;

export const integrationHealthGithubFailureAlarm = isMonitoredStage
  ? new sst.aws.SnsTopic('IntegrationHealthGithubFailureAlarm')
  : undefined;

export const integrationHealthJiraFailureAlarm = isMonitoredStage
  ? new sst.aws.SnsTopic('IntegrationHealthJiraFailureAlarm')
  : undefined;

export const integrationHealthConfluenceFailureAlarm = isMonitoredStage
  ? new sst.aws.SnsTopic('IntegrationHealthConfluenceFailureAlarm')
  : undefined;

export const integrationHealthLatencyAlarm = isMonitoredStage
  ? new sst.aws.SnsTopic('IntegrationHealthLatencyAlarm')
  : undefined;

export const integrationHealthAllDownAlarm = isMonitoredStage
  ? new sst.aws.SnsTopic('IntegrationHealthAllDownAlarm')
  : undefined;

export const circuitBreakerOpenAlarm = isMonitoredStage ? new sst.aws.SnsTopic('CircuitBreakerOpenAlarm') : undefined;

export const agentInflightStepsPersistFailedAlarm = isMonitoredStage
  ? new sst.aws.SnsTopic('AgentInflightStepsPersistFailedAlarm')
  : undefined;

export const agentCheckpointDepthWarningAlarm = isMonitoredStage
  ? new sst.aws.SnsTopic('AgentCheckpointDepthWarningAlarm')
  : undefined;

export const agentCheckpointDepthExceededAlarm = isMonitoredStage
  ? new sst.aws.SnsTopic('AgentCheckpointDepthExceededAlarm')
  : undefined;

export const websocketRouteOomAlarm = isMonitoredStage ? new sst.aws.SnsTopic('WebSocketRouteOomAlarm') : undefined;

// --- MetricAlarm definitions (only created for monitored stages) ---

if (isMonitoredStage) {
  /**
   * Alarm: Agent Checkpoint Depth Warning
   *
   * Fires when an execution's agentContinuationQueue self-dispatch depth exceeds 25.
   * Depth 25 = ~6.25h of wall-clock time (25 x 15 min); any legitimate run should be
   * done well before this. Indicates a runaway agent loop or a stuck abort signal.
   * Hard limit at depth 50 (~12.5h) terminates the execution automatically; this alarm
   * fires at 25 so ops can investigate before the hard limit is reached.
   *
   * Metric emitted by: agentExecutor.ts → processExecution()
   * Namespace: Lumina5/AgentExecutor / CheckpointDepthWarning
   */
  new aws.cloudwatch.MetricAlarm('agentCheckpointDepthWarning', {
    name: `${$app.name}-${$app.stage}-agent-checkpoint-depth-warning`,
    alarmDescription: 'Agent execution self-dispatch depth exceeded warning threshold (25) — possible runaway loop',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'CheckpointDepthWarning',
    namespace: 'Lumina5/AgentExecutor',
    period: 300, // 5 minutes
    statistic: 'Sum',
    threshold: 0, // Any occurrence is noteworthy
    treatMissingData: 'notBreaching',
    alarmActions: [agentCheckpointDepthWarningAlarm!.arn],
    tags: {
      Application: 'AgentExecutor',
      Severity: 'Warning',
    },
  });

  /**
   * Alarm: Agent Checkpoint Depth Exceeded (hard limit)
   *
   * Fires when an execution has been terminated by the hard checkpoint-depth ceiling (50).
   * Depth 50 = ~12.5h of wall-clock time; reaching this limit means the execution died
   * without completing — requires ops investigation to determine whether it was a
   * legitimate long-running run or a runaway loop.
   *
   * Metric emitted by: agentExecutor.ts → processExecution()
   * Namespace: Lumina5/AgentExecutor / CheckpointDepthExceeded
   */
  new aws.cloudwatch.MetricAlarm('agentCheckpointDepthExceeded', {
    name: `${$app.name}-${$app.stage}-agent-checkpoint-depth-exceeded`,
    alarmDescription:
      'Agent execution terminated by hard checkpoint-depth limit (50) — execution killed as possible runaway loop',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'CheckpointDepthExceeded',
    namespace: 'Lumina5/AgentExecutor',
    period: 300, // 5 minutes
    statistic: 'Sum',
    threshold: 0, // Any occurrence means an execution was forcibly terminated
    treatMissingData: 'notBreaching',
    alarmActions: [agentCheckpointDepthExceededAlarm!.arn],
    tags: {
      Application: 'AgentExecutor',
      Severity: 'High',
    },
  });

  /**
   * Alarm: High Failure Count
   *
   * Triggers when more than 2 failures occur in a 5-minute period.
   * This indicates systematic issues with modal generation that require immediate attention.
   */
  new aws.cloudwatch.MetricAlarm('whatsNewHighFailures', {
    name: `${$app.name}-${$app.stage}-whats-new-high-failures`,
    alarmDescription: "What's New modal generation has multiple failures",
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'Failure',
    namespace: 'Lumina5/ModalGeneration',
    period: 300, // 5 minutes
    statistic: 'Sum',
    threshold: 2, // More than 2 failures
    treatMissingData: 'notBreaching',
    alarmActions: [whatsNewFailureAlarm!.arn],
    tags: {
      Application: 'WhatsNewGeneration',
      Severity: 'High',
    },
  });

  /**
   * Alarm: Processing Duration Exceeded
   *
   * Triggers when processing takes longer than 2 minutes.
   * Long durations indicate LLM performance issues or timeout problems.
   */
  new aws.cloudwatch.MetricAlarm('whatsNewLongDuration', {
    name: `${$app.name}-${$app.stage}-whats-new-long-duration`,
    alarmDescription: "What's New modal generation exceeds 2 minutes",
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'Duration',
    namespace: 'Lumina5/ModalGeneration',
    period: 300, // 5 minutes
    statistic: 'Average',
    threshold: 120000, // 2 minutes in milliseconds
    treatMissingData: 'notBreaching',
    alarmActions: [whatsNewDurationAlarm!.arn],
    tags: {
      Application: 'WhatsNewGeneration',
      Severity: 'Medium',
    },
  });

  /**
   * Alarm: High Cost Per Generation
   *
   * Triggers when estimated cost per generation exceeds $0.05.
   * Helps prevent unexpected LLM cost overruns.
   */
  new aws.cloudwatch.MetricAlarm('whatsNewHighCost', {
    name: `${$app.name}-${$app.stage}-whats-new-high-cost`,
    alarmDescription: "What's New modal generation cost exceeds $0.05",
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'EstimatedCost',
    namespace: 'Lumina5/ModalGeneration',
    period: 300, // 5 minutes
    statistic: 'Maximum',
    threshold: 0.05, // $0.05
    treatMissingData: 'notBreaching',
    alarmActions: [whatsNewCostAlarm!.arn],
    tags: {
      Application: 'WhatsNewGeneration',
      Severity: 'Medium',
    },
  });

  /**
   * Alarm: Lambda Function Errors
   *
   * Monitors the Lambda function itself for execution errors.
   * Complements the application-level failure metric.
   */
  new aws.cloudwatch.MetricAlarm('whatsNewLambdaErrors', {
    name: `${$app.name}-${$app.stage}-whats-new-lambda-errors`,
    alarmDescription: "What's New generation Lambda has errors",
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'Errors',
    namespace: 'AWS/Lambda',
    period: 300,
    statistic: 'Sum',
    threshold: 0,
    treatMissingData: 'notBreaching',
    dimensions: {
      FunctionName: whatsNewGenerationQueueSubscription.nodes.function.name,
    },
    alarmActions: [whatsNewLambdaErrorAlarm!.arn],
    tags: {
      Application: 'WhatsNewGeneration',
      Severity: 'High',
    },
  });

  /**
   * Alarm: Anthropic API Rate Limit Errors
   *
   * Triggers when rate limit errors exceed threshold after SDK retries are exhausted.
   * This indicates the Anthropic API concurrent connection limit is being hit,
   * requiring investigation or rate limit increase from Anthropic.
   */
  new aws.cloudwatch.MetricAlarm('anthropicRateLimitErrors', {
    name: `${$app.name}-${$app.stage}-anthropic-rate-limit-errors`,
    alarmDescription: 'Anthropic API rate limit errors detected (after SDK retries exhausted)',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'RateLimitError',
    namespace: 'Lumina5/AnthropicAPI',
    period: 300, // 5 minutes
    statistic: 'Sum',
    threshold: 5, // Alert on more than 5 rate limit errors in 5 minutes
    treatMissingData: 'notBreaching',
    dimensions: {
      Stage: $app.stage,
    },
    alarmActions: [anthropicRateLimitAlarm!.arn],
    tags: {
      Application: 'AnthropicAPI',
      Severity: 'High',
    },
  });

  /**
   * Alarm: LiveOps Triage Failure
   *
   * Triggers when triage run fails.
   * Indicates issues with Slack/GitHub integration or LLM processing.
   */
  new aws.cloudwatch.MetricAlarm('liveopsTriageFailure', {
    name: `${$app.name}-${$app.stage}-liveops-triage-failure`,
    alarmDescription: 'LiveOps Triage run failed',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'TriageRunFailure',
    namespace: 'Lumina5/LiveOpsTriage',
    period: 86400, // 24 hours (matches daily schedule)
    statistic: 'Sum',
    threshold: 0, // Alert on any failure
    treatMissingData: 'notBreaching',
    alarmActions: [liveopsTriageFailureAlarm!.arn],
    tags: {
      Application: 'LiveOpsTriage',
      Severity: 'High',
    },
  });

  /**
   * Alarm: High Error Volume
   *
   * Triggers when more than 50 errors are processed in a single run.
   * Indicates a potential incident requiring immediate attention.
   */
  new aws.cloudwatch.MetricAlarm('liveopsHighErrorVolume', {
    name: `${$app.name}-${$app.stage}-liveops-high-error-volume`,
    alarmDescription: 'LiveOps Triage detected high error volume (potential incident)',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'ErrorsProcessed',
    namespace: 'Lumina5/LiveOpsTriage',
    period: 86400, // 24 hours
    statistic: 'Maximum',
    threshold: 50, // More than 50 errors
    treatMissingData: 'notBreaching',
    alarmActions: [liveopsHighErrorVolumeAlarm!.arn],
    tags: {
      Application: 'LiveOpsTriage',
      Severity: 'Critical',
    },
  });

  /**
   * Alarm: P0 Issues Created
   *
   * Triggers when any P0 (blocker) issues are created.
   * P0 issues require immediate attention.
   */
  new aws.cloudwatch.MetricAlarm('liveopsP0Issues', {
    name: `${$app.name}-${$app.stage}-liveops-p0-issues`,
    alarmDescription: 'LiveOps Triage created P0 (blocker) issues - immediate attention required',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'IssuesCreated',
    namespace: 'Lumina5/LiveOpsTriage',
    period: 86400, // 24 hours
    statistic: 'Maximum',
    threshold: 0, // Alert on any P0 issues
    treatMissingData: 'notBreaching',
    dimensions: {
      Priority: 'P0',
    },
    alarmActions: [liveopsP0IssuesAlarm!.arn],
    tags: {
      Application: 'LiveOpsTriage',
      Severity: 'Critical',
    },
  });

  /**
   * Alarm: P1 Issues Created
   *
   * Triggers when any P1 (critical) issues are created.
   * P1 issues indicate major features broken or significant user impact.
   */
  new aws.cloudwatch.MetricAlarm('liveopsP1Issues', {
    name: `${$app.name}-${$app.stage}-liveops-p1-issues`,
    alarmDescription: 'LiveOps Triage created P1 (critical) issues - major feature broken, significant user impact',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'IssuesCreated',
    namespace: 'Lumina5/LiveOpsTriage',
    period: 86400, // 24 hours
    statistic: 'Maximum',
    threshold: 0, // Alert on any P1 issues
    treatMissingData: 'notBreaching',
    dimensions: {
      Priority: 'P1',
    },
    alarmActions: [liveopsP1IssuesAlarm!.arn],
    tags: {
      Application: 'LiveOpsTriage',
      Severity: 'High',
    },
  });

  /**
   * Alarm: Consecutive Triage Failures
   *
   * Triggers when triage fails 2 or more times in a 48-hour period.
   * Indicates systematic issues that require investigation (token expiration,
   * API changes, configuration drift).
   */
  new aws.cloudwatch.MetricAlarm('liveopsConsecutiveFailures', {
    name: `${$app.name}-${$app.stage}-liveops-consecutive-failures`,
    alarmDescription: 'LiveOps Triage has failed 2+ times in 48hrs - systematic issue detected',
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 1,
    metricName: 'TriageRunFailure',
    namespace: 'Lumina5/LiveOpsTriage',
    period: 172800, // 48 hours
    statistic: 'Sum',
    threshold: 2, // 2 or more failures in 48 hours
    treatMissingData: 'notBreaching',
    alarmActions: [liveopsConsecutiveFailuresAlarm!.arn],
    tags: {
      Application: 'LiveOpsTriage',
      Severity: 'Critical',
    },
  });

  /**
   * Alarm: High Webhook Delivery Failure Rate
   *
   * Triggers when more than 10 failures occur in a 5-minute period.
   * Indicates systematic issues with delivery endpoints or subscriber health.
   */
  new aws.cloudwatch.MetricAlarm('webhookDeliveryHighFailures', {
    name: `${$app.name}-${$app.stage}-webhook-delivery-high-failures`,
    alarmDescription: 'Webhook delivery failure rate exceeds threshold',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'DeliveryFailed',
    namespace: 'Lumina5/WebhookDelivery',
    period: 300, // 5 minutes
    statistic: 'Sum',
    threshold: 10, // More than 10 failures in 5 min
    treatMissingData: 'notBreaching',
    alarmActions: [webhookDeliveryFailureAlarm!.arn],
    tags: {
      Application: 'WebhookDelivery',
      Severity: 'High',
    },
  });

  /**
   * Alarm: Webhook Delivery High Latency
   *
   * Triggers when P95 delivery latency exceeds 30 seconds.
   * Indicates slow subscriber endpoints or network issues.
   */
  new aws.cloudwatch.MetricAlarm('webhookDeliveryHighLatency', {
    name: `${$app.name}-${$app.stage}-webhook-delivery-high-latency`,
    alarmDescription: 'Webhook delivery P95 latency exceeds 30 seconds',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'DeliveryLatency',
    namespace: 'Lumina5/WebhookDelivery',
    period: 300, // 5 minutes
    extendedStatistic: 'p95',
    threshold: 30000, // 30 seconds in milliseconds
    treatMissingData: 'notBreaching',
    alarmActions: [webhookDeliveryLatencyAlarm!.arn],
    tags: {
      Application: 'WebhookDelivery',
      Severity: 'Medium',
    },
  });

  /**
   * Alarm: Webhook Delivery Lambda Errors
   *
   * Monitors the Lambda function itself for execution errors.
   * Complements the application-level failure metric.
   */
  new aws.cloudwatch.MetricAlarm('webhookDeliveryLambdaErrors', {
    name: `${$app.name}-${$app.stage}-webhook-delivery-lambda-errors`,
    alarmDescription: 'Webhook delivery Lambda has errors',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'Errors',
    namespace: 'AWS/Lambda',
    period: 300, // 5 minutes
    statistic: 'Sum',
    threshold: 0, // Alert on any error
    treatMissingData: 'notBreaching',
    dimensions: {
      FunctionName: webhookDeliveryQueueSubscription.nodes.function.name,
    },
    alarmActions: [webhookDeliveryLambdaErrorAlarm!.arn],
    tags: {
      Application: 'WebhookDelivery',
      Severity: 'High',
    },
  });

  /**
   * Alarm: Integration Rate Limit Near Threshold
   *
   * Triggers when any integration's rate limit usage exceeds 80%.
   * Indicates approaching limits and potential service degradation.
   */
  new aws.cloudwatch.MetricAlarm('rateLimitWarning', {
    name: `${$app.name}-${$app.stage}-rate-limit-warning`,
    alarmDescription: 'Integration API rate limit usage exceeds 80%',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'NearLimit',
    namespace: 'Lumina5/RateLimits',
    period: 300, // 5 minutes
    statistic: 'Sum',
    threshold: 0, // Alert on any near-limit event
    treatMissingData: 'notBreaching',
    alarmActions: [rateLimitWarningAlarm!.arn],
    tags: {
      Application: 'IntegrationRateLimits',
      Severity: 'Medium',
    },
  });

  /**
   * Alarm: Integration Rate Limit Hit (429 Responses)
   *
   * Triggers when any integration receives 429 Too Many Requests responses.
   * Indicates the rate limit has been exceeded and requests are being throttled.
   */
  new aws.cloudwatch.MetricAlarm('rateLimitHit', {
    name: `${$app.name}-${$app.stage}-rate-limit-hit`,
    alarmDescription: 'Integration API rate limit exceeded (429 responses detected)',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'Throttled',
    namespace: 'Lumina5/RateLimits',
    period: 300, // 5 minutes
    statistic: 'Sum',
    threshold: 0, // Alert on any throttle event
    treatMissingData: 'notBreaching',
    alarmActions: [rateLimitHitAlarm!.arn],
    tags: {
      Application: 'IntegrationRateLimits',
      Severity: 'High',
    },
  });

  /**
   * Per-Integration Consecutive Failure Alarms
   *
   * Triggers when 3+ failures occur in a 15-minute window (3 probe cycles).
   * Indicates a sustained outage for a specific integration requiring investigation.
   */
  new aws.cloudwatch.MetricAlarm('integrationHealthSlackFailures', {
    name: `${$app.name}-${$app.stage}-integration-health-slack-failures`,
    alarmDescription: 'Slack integration health probe has 3+ consecutive failures',
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 1,
    metricName: 'Failure',
    namespace: 'Lumina5/IntegrationHealth',
    period: 900, // 15 minutes (3 probe cycles at 5-min intervals)
    statistic: 'Sum',
    threshold: 3,
    treatMissingData: 'notBreaching',
    dimensions: { Integration: 'slack' },
    alarmActions: [integrationHealthSlackFailureAlarm!.arn],
    tags: {
      Application: 'IntegrationHealth',
      Severity: 'High',
    },
  });

  new aws.cloudwatch.MetricAlarm('integrationHealthGithubFailures', {
    name: `${$app.name}-${$app.stage}-integration-health-github-failures`,
    alarmDescription: 'GitHub integration health probe has 3+ consecutive failures',
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 1,
    metricName: 'Failure',
    namespace: 'Lumina5/IntegrationHealth',
    period: 900,
    statistic: 'Sum',
    threshold: 3,
    treatMissingData: 'notBreaching',
    dimensions: { Integration: 'github' },
    alarmActions: [integrationHealthGithubFailureAlarm!.arn],
    tags: {
      Application: 'IntegrationHealth',
      Severity: 'High',
    },
  });

  new aws.cloudwatch.MetricAlarm('integrationHealthJiraFailures', {
    name: `${$app.name}-${$app.stage}-integration-health-jira-failures`,
    alarmDescription: 'Jira integration health probe has 3+ consecutive failures',
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 1,
    metricName: 'Failure',
    namespace: 'Lumina5/IntegrationHealth',
    period: 900,
    statistic: 'Sum',
    threshold: 3,
    treatMissingData: 'notBreaching',
    dimensions: { Integration: 'jira' },
    alarmActions: [integrationHealthJiraFailureAlarm!.arn],
    tags: {
      Application: 'IntegrationHealth',
      Severity: 'High',
    },
  });

  new aws.cloudwatch.MetricAlarm('integrationHealthConfluenceFailures', {
    name: `${$app.name}-${$app.stage}-integration-health-confluence-failures`,
    alarmDescription: 'Confluence integration health probe has 3+ consecutive failures',
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 1,
    metricName: 'Failure',
    namespace: 'Lumina5/IntegrationHealth',
    period: 900,
    statistic: 'Sum',
    threshold: 3,
    treatMissingData: 'notBreaching',
    dimensions: { Integration: 'confluence' },
    alarmActions: [integrationHealthConfluenceFailureAlarm!.arn],
    tags: {
      Application: 'IntegrationHealth',
      Severity: 'High',
    },
  });

  /**
   * Alarm: Integration Health High Latency
   *
   * Triggers when P95 latency across all integrations exceeds 5 seconds.
   * Indicates network degradation or slow API responses requiring investigation.
   */
  new aws.cloudwatch.MetricAlarm('integrationHealthHighLatency', {
    name: `${$app.name}-${$app.stage}-integration-health-high-latency`,
    alarmDescription: 'Integration health probe P95 latency exceeds 5 seconds',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'Latency',
    namespace: 'Lumina5/IntegrationHealth',
    period: 300, // 5 minutes
    extendedStatistic: 'p95',
    threshold: 5000, // 5 seconds in milliseconds
    treatMissingData: 'notBreaching',
    alarmActions: [integrationHealthLatencyAlarm!.arn],
    tags: {
      Application: 'IntegrationHealth',
      Severity: 'Medium',
    },
  });

  /**
   * Alarm: All Integrations Down
   *
   * Triggers when zero successful probes are recorded in a 15-minute window.
   * Indicates a systemic issue (network outage, Lambda failure, DB connectivity)
   * rather than a single integration problem.
   */
  new aws.cloudwatch.MetricAlarm('integrationHealthAllDown', {
    name: `${$app.name}-${$app.stage}-integration-health-all-down`,
    alarmDescription: 'All integration health probes failing - possible systemic issue',
    comparisonOperator: 'LessThanThreshold',
    evaluationPeriods: 1,
    metricName: 'Success',
    namespace: 'Lumina5/IntegrationHealth',
    period: 900, // 15 minutes (3 probe cycles)
    statistic: 'Sum',
    threshold: 1, // Less than 1 success = zero successes
    treatMissingData: 'notBreaching',
    alarmActions: [integrationHealthAllDownAlarm!.arn],
    tags: {
      Application: 'IntegrationHealth',
      Severity: 'Critical',
    },
  });

  /**
   * Alarm: Circuit Breaker Opened
   *
   * Triggers when any in-memory circuit breaker transitions to OPEN state.
   * Indicates real-time detection of an integration outage (5 failures in 2 min),
   * complementing the slower DB-backed probe system.
   */
  new aws.cloudwatch.MetricAlarm('circuitBreakerOpen', {
    name: `${$app.name}-${$app.stage}-circuit-breaker-open`,
    alarmDescription: 'In-memory circuit breaker opened for an integration - real-time outage detection',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'CircuitOpen',
    namespace: 'Lumina5/CircuitBreaker',
    period: 300, // 5 minutes
    statistic: 'Maximum',
    threshold: 0, // Alert when any integration's breaker opens (value = 1)
    treatMissingData: 'notBreaching',
    alarmActions: [circuitBreakerOpenAlarm!.arn],
    tags: {
      Application: 'CircuitBreaker',
      Severity: 'High',
    },
  });

  /**
   * Alarm: Agent in-flight steps persist failures (P2)
   *
   * The `streamStep` listener in agentExecutor.ts persists `checkpoint.steps`
   * per agent emission so a mid-iteration refresh replays correctly (see #8771).
   * Writes are fire-and-forget — a single failure is benign (the boundary
   * `updateCheckpoint` at iteration end still covers correctness), but a sustained
   * failure pattern means users see the pre-fix blank-replay behavior again on
   * refresh during long tool calls. Threshold > 10 in 5 min flags MongoDB
   * degradation specifically affecting this code path. Notify, do not page.
   */
  new aws.cloudwatch.MetricAlarm('agentInflightStepsPersistFailed', {
    name: `${$app.name}-${$app.stage}-agent-inflight-steps-persist-failed`,
    alarmDescription:
      'Agent in-flight checkpoint.steps writes failing repeatedly — mid-iteration refresh replay may be degraded',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'InflightStepsPersistFailed',
    namespace: 'Lumina5/AgentExecutor',
    period: 300, // 5 minutes
    statistic: 'Sum',
    threshold: 10,
    treatMissingData: 'notBreaching',
    alarmActions: [agentInflightStepsPersistFailedAlarm!.arn],
    tags: {
      Application: 'AgentExecutor',
      Severity: 'Medium',
    },
  });

  /**
   * Alarm: WebSocket Route Out-Of-Memory (#8655)
   *
   * Lambda OOM/SIGKILL events surface only in logs (no native CloudWatch metric) and often during
   * INIT with no application output — exactly the failure mode that hit agent_execute at 256 MB.
   * subscribe_query / unsubscribe_query are now at 1024 MB, but a log-metric filter on the OOM
   * signatures publishes a metric so a future regression (memory drop, dependency bloat) pages
   * loudly instead of degrading silently. Each route publishes to its OWN metric name and gets its
   * own alarm (sharing one SNS topic), so a firing alarm names the culprit route directly.
   *
   * NOTE: we deliberately do NOT use a single metric dimensioned by route. CloudWatch only allows
   * metric-filter dimensions whose values are extracted from named tokens in the filter pattern;
   * our pattern is an unstructured term match (no captures), so AWS rejects dimensions on it with
   * "The specified filter pattern does not support dimensions". Distinct metric names per route give
   * the same per-route attribution while remaining a valid PutMetricFilter call.
   */
  const oomLogGroupName = (route: typeof subscribeQueryRoute) =>
    route.nodes.function
      .apply(fn => fn.nodes.logGroup)
      .apply(logGroup => {
        if (!logGroup) throw new Error('WebSocket route function is missing its CloudWatch log group');
        return logGroup.name;
      });

  for (const { key, metricName, route } of [
    { key: 'subscribe-query', metricName: 'SubscribeQueryOutOfMemory', route: subscribeQueryRoute },
    { key: 'unsubscribe-query', metricName: 'UnsubscribeQueryOutOfMemory', route: unsubscribeQueryRoute },
  ]) {
    new aws.cloudwatch.LogMetricFilter(`websocketRouteOomFilter-${key}`, {
      name: `${$app.name}-${$app.stage}-${key}-oom`,
      logGroupName: oomLogGroupName(route),
      // `?` prefixes OR the terms. Covers the managed-runtime OOM report, a SIGKILL from the
      // memory cgroup, and V8 heap exhaustion thrown before the runtime reports.
      pattern: '?"Runtime.OutOfMemory" ?"signal: killed" ?"JavaScript heap out of memory"',
      metricTransformation: {
        name: metricName,
        namespace: 'Lumina5/WebSocketRoutes',
        value: '1',
        unit: 'Count',
      },
    });

    new aws.cloudwatch.MetricAlarm(`websocketRouteOom-${key}`, {
      name: `${$app.name}-${$app.stage}-${key}-oom`,
      alarmDescription: `WebSocket ${key} route Lambda hit OOM or was killed — investigate and bump memory`,
      comparisonOperator: 'GreaterThanThreshold',
      evaluationPeriods: 1,
      metricName,
      namespace: 'Lumina5/WebSocketRoutes',
      period: 300, // 5 minutes
      statistic: 'Sum',
      threshold: 0, // Alert on any OOM/kill event
      treatMissingData: 'notBreaching',
      alarmActions: [websocketRouteOomAlarm!.arn],
      tags: {
        Application: 'WebSocketRoutes',
        Severity: 'High',
      },
    });
  }
}

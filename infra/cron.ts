import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { emailJobQueue } from './emailMarketing';
import { allSecrets } from './secrets';
import {
  researchEngineQueue,
  agentProactiveMessageQueue,
  whatsNewGenerationQueue,
  whatsNewHighlightsQueue,
  liveOpsTriageQueue,
  deepAgentWakeQueue,
} from './queues';
import { lambdaVpc } from './vpc';
import { fabFileBucket, generatedImagesBucket } from './buckets';

const scheduleTaskCron = new sst.aws.Cron('scheduleTaskCron', {
  schedule: 'rate(5 minutes)',
  function: {
    vpc: lambdaVpc,
    handler: 'apps/client/server/cron/scheduler.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, researchEngineQueue, fabFileBucket, generatedImagesBucket],
    timeout: '10 minutes',
    logging: {
      retention: '3 days',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['sqs:*'],
        resources: ['*'],
      },
      {
        actions: ['events:*'],
        resources: ['*'],
      },
    ],
  },
});

const agentProactiveMessageCron = new sst.aws.Cron('agentProactiveMessageCron', {
  schedule: 'rate(1 hour)',
  function: {
    vpc: lambdaVpc,
    handler: 'apps/client/server/cron/agentProactiveMessaging.checkAndScheduleProactiveMessages',
    runtime: 'nodejs24.x',
    link: [...allSecrets, agentProactiveMessageQueue],
    timeout: '10 minutes',
    logging: {
      retention: '3 days',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
  },
});

// Unified user activity report function (used by both daily and weekly schedules)
const userActivityReportFunction = new sst.aws.Function('userActivityReportFunction', {
  vpc: lambdaVpc,
  handler: 'apps/client/server/cron/userActivityReport.handler',
  runtime: 'nodejs24.x',
  timeout: '10 minutes',
  link: [...allSecrets],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  logging: {
    retention: '3 days',
  },
  dev: false,
});

// Daily report - runs every day at 00:00 CST (05:00 UTC)
const dailyUserActivityReport = new sst.aws.Cron('dailyUserActivityReport', {
  // Expressions are in UTC+0. We want to run it every day at 00:00 CST.
  schedule: 'cron(0 5 * * ? *)',
  job: userActivityReportFunction.arn,
  event: { reportType: 'daily' },
  enabled: $app.stage === 'production',
});

// Weekly report - runs every Monday at 00:00 CST (05:00 UTC)
const weeklyUserActivityReport = new sst.aws.Cron('weeklyUserActivityReport', {
  schedule: 'cron(0 5 ? * MON *)',
  job: userActivityReportFunction.arn,
  event: { reportType: 'weekly' },
  enabled: $app.stage === 'production',
});

const secretRotationNotifierCron = new sst.aws.Cron('secretRotationNotifier', {
  // Daily check at 9am UTC (4am EST)
  schedule: 'cron(0 9 * * ? *)',
  function: {
    vpc: lambdaVpc,
    handler: 'apps/client/server/cron/secretRotationNotifier.handler',
    runtime: 'nodejs24.x',
    timeout: '1 minute',
    link: [...allSecrets],
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    logging: {
      retention: '3 days',
    },
  },
  enabled: ['production', 'dev'].includes($app.stage),
});

// [DELETION-FOOTPRINT] Team Metrics Refresh cron moved to @bike4mind/premium-pi
// (contributeInfra in packages/premium/pi/src/infra.ts) during the Pi open-core carve.

// API Key Baseline Calculation - runs daily at 2am UTC (9pm CST previous day)
// Calculates normal usage patterns for each user's API keys based on last 30 days
const apiKeyBaselineCalculation = new sst.aws.Cron('apiKeyBaselineCalculation', {
  schedule: 'cron(0 2 * * ? *)', // Daily at 2am UTC
  function: {
    vpc: lambdaVpc,
    handler: 'apps/client/server/cron/apiKeyBaselineCalculation.handler',
    runtime: 'nodejs24.x',
    timeout: '15 minutes', // May need time for users with many API keys
    link: [...allSecrets],
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    logging: {
      retention: '1 week', // Keep logs longer for debugging baseline calculations
    },
  },
  enabled: ['production', 'dev'].includes($app.stage),
});

// Email campaign scheduler - runs every 5 minutes to check for scheduled campaigns
const emailCampaignSchedulerCron = new sst.aws.Cron('emailCampaignScheduler', {
  schedule: 'rate(5 minutes)',
  function: {
    vpc: lambdaVpc,
    handler: 'apps/client/server/cron/emailCampaignScheduler.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, emailJobQueue],
    timeout: '2 minutes',
    logging: {
      retention: '1 week',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
  },
});

/**
 * What's New Sync Cron
 * Fetches latest What's New modal from production S3 and imports to local DB.
 *
 * CRITICAL: Only enabled for non-production environments (dev, staging, forks)
 * - production: DISABLED - production GENERATES modals, doesn't import them
 * - dev/staging/forks: ENABLED - imports modals from production
 *
 * Schedule: Daily at 9am UTC (3am CST) - 2 hours after production generates at 7am UTC (1am CST)
 * Checks autoSyncEnabled config before importing.
 */
const whatsNewSyncCron = new sst.aws.Cron('whatsNewSyncCron', {
  schedule: 'cron(0 9 * * ? *)', // 9am UTC daily (3am CST)
  function: {
    handler: 'apps/client/server/cron/whatsNewSync.handler',
    vpc: lambdaVpc,
    link: [...allSecrets],
    timeout: '2 minutes',
    runtime: 'nodejs24.x',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    logging: {
      retention: '3 days',
    },
    permissions: [
      {
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      },
    ],
  },
  // CRITICAL: Only enabled for non-production stages
  enabled: $app.stage !== 'production',
});

/**
 * LiveOps Triage Dispatcher (Multi-Config)
 * Dispatches triage jobs to SQS for each enabled LiveOpsTriageConfig.
 *
 * Schedule: Every 6 hours at 2am, 8am, 2pm, 8pm CST (8, 14, 20, 2 UTC)
 * For each enabled config where shouldRunAtCurrentHour(config.runIntervalHours) is true:
 * - Publishes SQS message with { configId, dispatchedAt }
 *
 * Workers process jobs independently via SQS fan-out pattern.
 * Only enabled in production environment.
 */
const liveopsTriageDispatcherCron = new sst.aws.Cron('liveopsTriageDispatcherCron', {
  schedule: 'cron(0 2,8,14,20 * * ? *)', // Every 6 hours UTC
  function: {
    handler: 'apps/client/server/cron/liveopsTriageDispatcher.handler',
    vpc: lambdaVpc,
    link: [...allSecrets, liveOpsTriageQueue],
    timeout: '2 minutes',
    runtime: 'nodejs24.x',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    logging: {
      retention: '1 week',
    },
    permissions: [
      {
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      },
      {
        actions: ['sqs:SendMessage'],
        resources: [liveOpsTriageQueue.arn],
      },
    ],
  },
  // Only enabled in production
  enabled: $app.stage === 'production',
});

/**
 * What's New Daily Modal Generation Cron
 * Collects merged PRs/commits from GitHub and dispatches to the generation queue.
 * Replaces the GitHub Actions workflow (generate-whats-new-modal-production.yml).
 *
 * Schedule: Daily at 7am UTC (1am CST)
 * Only runs in production environment.
 */
const whatsNewGenerationCron = new sst.aws.Cron('whatsNewGenerationCron', {
  schedule: 'cron(0 7 * * ? *)', // 7am UTC daily (1am CST)
  function: {
    handler: 'apps/client/server/cron/whatsNewGeneration.handler',
    vpc: lambdaVpc,
    link: [...allSecrets, whatsNewGenerationQueue],
    timeout: '2 minutes',
    runtime: 'nodejs24.x',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    logging: {
      retention: '1 week',
    },
    permissions: [
      {
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      },
      {
        actions: ['sqs:SendMessage'],
        resources: [whatsNewGenerationQueue.arn],
      },
    ],
  },
  // Only enabled in production - replaces GitHub Actions workflow
  enabled: $app.stage === 'production',
});

/**
 * What's New Weekly Highlights Cron
 * Generates a weekly summary of What's New modals and posts to Slack.
 *
 * Schedule: Weekly on Saturday at 2am CST (8:00 UTC)
 * Runs 1 hour after the daily What's New modal generation (7am UTC)
 * Only runs in production environment.
 *
 * Workflow:
 * 1. Fetches What's New modals from the past 7 days
 * 2. Uses LLM to generate highlights summary
 * 3. Posts formatted highlights to configured Slack channel
 */
const whatsNewHighlightsCron = new sst.aws.Cron('whatsNewHighlightsCron', {
  schedule: 'cron(0 8 ? * SAT *)', // 2am CST / 8am UTC every Saturday (1hr after modal generation)
  function: {
    handler: 'apps/client/server/cron/whatsNewHighlights.handler',
    vpc: lambdaVpc,
    link: [...allSecrets, whatsNewHighlightsQueue],
    timeout: '2 minutes',
    runtime: 'nodejs24.x',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    logging: {
      retention: '1 week',
    },
    permissions: [
      {
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      },
    ],
  },
  // Only enabled in production - fork environments should not generate highlights
  enabled: $app.stage === 'production',
});

// Telemetry TTL Cleanup — GDPR Article 5(1)(e) storage limitation
// Removes contextTelemetry from Quest documents older than 90 days
const telemetryCleanupCron = new sst.aws.Cron('telemetryCleanup', {
  schedule: 'cron(0 3 * * ? *)', // Daily at 3am UTC
  function: {
    vpc: lambdaVpc,
    handler: 'apps/client/server/cron/telemetryCleanup.handler',
    runtime: 'nodejs24.x',
    timeout: '10 minutes',
    link: [...allSecrets],
    environment: { ...DEFAULT_LAMBDA_ENVIRONMENT },
    logging: {
      retention: '1 week',
    },
  },
  enabled: ['production', 'dev'].includes($app.stage),
});

// Credit Lot Sweep — reconciles the CreditLot parallel ledger against
// currentCredits: assigns cumulative consumption soonest-to-expire-first and
// expires stale remainders (see #190 design).
const creditLotSweepCron = new sst.aws.Cron('creditLotSweep', {
  schedule: 'cron(0 4 * * ? *)', // Daily at 4am UTC
  function: {
    vpc: lambdaVpc,
    handler: 'apps/client/server/cron/creditLotSweep.handler',
    runtime: 'nodejs24.x',
    timeout: '10 minutes',
    link: [...allSecrets],
    environment: { ...DEFAULT_LAMBDA_ENVIRONMENT },
    logging: {
      retention: '1 week',
    },
  },
  enabled: ['production', 'dev'].includes($app.stage),
});

// Integration Health Check - runs every 5 minutes to probe external APIs
// Probes: Slack, GitHub, Jira, Confluence
const integrationHealthCheckCron = new sst.aws.Cron('integrationHealthCheck', {
  schedule: 'rate(5 minutes)',
  function: {
    vpc: lambdaVpc,
    handler: 'apps/client/server/cron/integrationHealthCheck.handler',
    runtime: 'nodejs24.x',
    timeout: '2 minutes',
    link: [...allSecrets],
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    logging: {
      retention: '1 day',
    },
    permissions: [
      {
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      },
    ],
  },
  enabled: ['production', 'dev'].includes($app.stage),
});

// Cloud Security Scan - runs daily to evaluate baseline AWS configuration
const cloudSecurityScanCron = new sst.aws.Cron('CloudSecurityScan', {
  schedule: 'rate(1 day)',
  function: {
    vpc: lambdaVpc,
    handler: 'apps/client/server/security/cloudScan.handler',
    runtime: 'nodejs24.x',
    timeout: '5 minutes',
    link: [...allSecrets],
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    logging: {
      retention: '3 days',
    },
    permissions: [
      {
        actions: ['iam:GetAccountSummary'],
        resources: ['*'],
      },
      {
        actions: ['s3:ListAllMyBuckets', 's3:GetBucketPublicAccessBlock', 's3:GetEncryptionConfiguration'],
        resources: ['*'],
      },
      {
        actions: ['cloudtrail:DescribeTrails', 'cloudtrail:GetTrailStatus'],
        resources: ['*'],
      },
      {
        actions: ['ec2:DescribeSecurityGroups'],
        resources: ['*'],
      },
      {
        actions: [
          'iam:GenerateCredentialReport',
          'iam:GetCredentialReport',
          'iam:ListPolicies',
          'iam:GetPolicyVersion',
        ],
        resources: ['*'],
      },
      {
        actions: ['secretsmanager:ListSecrets'],
        resources: ['*'],
      },
    ],
  },
  enabled: ['production', 'dev'].includes($app.stage),
});

/**
 * LiveOps Triage Job Cleanup Cron
 * Detects and fails stuck jobs (processing > 13 minutes).
 *
 * Schedule: Every 10 minutes
 * Enabled: All stages (jobs can get stuck on any stage)
 */
const liveOpsTriageJobCleanupCron = new sst.aws.Cron('liveOpsTriageJobCleanup', {
  schedule: 'rate(10 minutes)',
  function: {
    handler: 'apps/client/server/cron/liveOpsTriageJobCleanup.handler',
    vpc: lambdaVpc,
    link: [...allSecrets],
    timeout: '1 minute',
    runtime: 'nodejs24.x',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    logging: {
      retention: '3 days',
    },
    permissions: [
      {
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      },
    ],
  },
});

/**
 * Security Scan Scheduler
 * Checks for scheduled security scans and triggers them via GitHub Actions.
 *
 * Schedule: Every hour
 * Scans are configured to run every Sunday at 2AM UTC by default.
 * Supports web, code, packages, secrets, and cloud security scans.
 *
 * Enabled for production and dev environments only.
 */
const securityScanSchedulerCron = new sst.aws.Cron('securityScanScheduler', {
  schedule: 'rate(1 hour)', // Check every hour
  function: {
    vpc: lambdaVpc,
    handler: 'apps/client/server/cron/securityScanScheduler.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets],
    timeout: '5 minutes',
    memory: '512 MB',
    logging: {
      retention: '1 week',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['events:*'],
        resources: ['*'],
      },
    ],
  },
  enabled: ['production', 'dev'].includes($app.stage),
});

// Deep Agent Wake Scheduler — scans for agents whose next wake is due
// (handoff.nextWakeAt <= now) and enqueues a wake per agent.
const deepAgentWakeCron = new sst.aws.Cron('deepAgentWakeCron', {
  schedule: 'rate(5 minutes)',
  function: {
    vpc: lambdaVpc,
    handler: 'apps/client/server/cron/deepAgentWake.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, deepAgentWakeQueue],
    timeout: '2 minutes',
    logging: {
      retention: '3 days',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
  },
  enabled: ['production', 'dev'].includes($app.stage),
});

/**
 * SRE Stale Dispatch Cleanup
 * Detects dispatches stuck in 'fixing' status (>60 minutes) and transitions them to 'failed'.
 *
 * Schedule: Every 15 minutes
 * Enabled: production and dev environments
 */
const sreStaleDispatchCron = new sst.aws.Cron('SreStaleDispatchCron', {
  schedule: 'rate(15 minutes)',
  function: {
    vpc: lambdaVpc,
    handler: 'apps/client/server/cron/sreStaleDispatch.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets],
    timeout: '2 minutes',
    logging: {
      retention: '3 days',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
  },
  enabled: ['production', 'dev'].includes($app.stage),
});

/**
 * Active Defense — Attack Simulation
 *
 * Standalone Lambda for the in-product attack simulation runner. Used both by the
 * scheduled cron below (Sunday 06:00 UTC) and by the admin "Run Now" endpoint, which
 * invokes this function asynchronously via the AWS SDK.
 *
 * Enabled for production and dev environments only. The runner has a domain guard that
 * refuses to probe anything other than the deployment's own hosts, derived from SERVER_DOMAIN
 * with no brand fallback (#9310/#9306).
 */
const attackSimulationFunction = new sst.aws.Function('attackSimulationFunction', {
  handler: 'apps/client/server/security/attackSimulation/runner.handler',
  vpc: lambdaVpc,
  link: [...allSecrets],
  timeout: '14 minutes',
  memory: '512 MB',
  runtime: 'nodejs24.x',
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  logging: {
    retention: '1 week',
  },
});

const attackSimulationCron = new sst.aws.Cron('attackSimulationCron', {
  schedule: 'cron(0 6 ? * SUN *)', // Sunday 06:00 UTC
  job: attackSimulationFunction.arn,
  event: { trigger: 'scheduled' },
  enabled: ['production', 'dev'].includes($app.stage),
});

/**
 * Data Lake Batch Reconcile (daily fallback)
 * Global watchdog: forces batches stuck non-terminal past the timeout to terminal via the same
 * guarded reconciler as the read-time path, so a batch that goes stuck while nobody opens their
 * batch list still terminalizes.
 *
 * Schedule: daily (5am UTC)
 * Enabled: production + dev
 */
const dataLakeBatchReconcileCron = new sst.aws.Cron('dataLakeBatchReconcile', {
  schedule: 'cron(0 5 * * ? *)', // Daily at 5am UTC (after telemetry 3am / creditLot 4am)
  function: {
    vpc: lambdaVpc,
    handler: 'apps/client/server/cron/dataLakeBatchReconcile.handler',
    runtime: 'nodejs24.x',
    timeout: '10 minutes',
    link: [...allSecrets],
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    logging: {
      retention: '1 week',
    },
    permissions: [
      {
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      },
    ],
  },
  enabled: ['production', 'dev'].includes($app.stage),
});

/**
 * Agent Execution Abandoned Sweep
 * Releases agent-execution slots that the reactive in-Lambda sweep cannot
 * reach because the owning user never returns to start another execution.
 * Transitions stale active executions to `failed` / `failureReason:
 * 'abandoned'`.
 *
 * Schedule: hourly
 * Enabled: production + dev
 */
const agentExecutionAbandonedSweepCron = new sst.aws.Cron('agentExecutionAbandonedSweep', {
  schedule: 'rate(1 hour)',
  function: {
    vpc: lambdaVpc,
    handler: 'apps/client/server/cron/agentExecutionAbandonedSweep.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets],
    timeout: '2 minutes',
    logging: {
      retention: '3 days',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      },
    ],
  },
  enabled: ['production', 'dev'].includes($app.stage),
});

export {
  dailyUserActivityReport,
  weeklyUserActivityReport,
  secretRotationNotifierCron,
  scheduleTaskCron,
  apiKeyBaselineCalculation,
  agentProactiveMessageCron,
  emailCampaignSchedulerCron,
  whatsNewSyncCron,
  liveopsTriageDispatcherCron,
  whatsNewGenerationCron,
  whatsNewHighlightsCron,
  cloudSecurityScanCron,
  integrationHealthCheckCron,
  liveOpsTriageJobCleanupCron,
  securityScanSchedulerCron,
  deepAgentWakeCron,
  telemetryCleanupCron,
  creditLotSweepCron,
  sreStaleDispatchCron,
  attackSimulationFunction,
  attackSimulationCron,
  agentExecutionAbandonedSweepCron,
  dataLakeBatchReconcileCron,
};

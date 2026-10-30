import { execFileSync, execSync } from 'child_process';
import { readFileSync } from 'fs';
import { computeHelpCorpusHash } from '@bike4mind/infra';
import { DEFAULT_LAMBDA_ENVIRONMENT, runsLoopScheduler, runsScheduledJobs } from './constants';
import { emailJobQueue } from './emailMarketing';
import { allSecrets } from './secrets';
import {
  researchEngineQueue,
  agentProactiveMessageQueue,
  liveOpsTriageQueue,
  deepAgentWakeQueue,
  dataLakeTaxonomyQueue,
  fabFileChunkQueue,
  driveLakeIngestQueue,
  githubLakeIngestQueue,
  githubLakeRevokeQueue,
  dataLakeResearchQueue,
  generationCallbackQueue,
  generationJobQueue,
} from './queues';
import { lambdaVpc } from './vpc';
import { appUrlForLambdaEnv } from './router';
import { fabFileBucket, generatedImagesBucket } from './buckets';
import { websocketApi } from './websocket';
import { youngAccountSpendAlertDeadLetter } from './youngAccountSpendAlertDeadLetter';
import { loopSchedulerDeadLetter } from './loopSchedulerDeadLetter';
import { agentExecutor } from './agentExecutor';
import { signupGrantHeldReleaseDeadLetter } from './signupGrantHeldReleaseDeadLetter';
import './businessMetricAlerts';

const scheduleTaskCron = new sst.aws.Cron('scheduleTaskCron', {
  schedule: 'rate(5 minutes)',
  function: {
    vpc: lambdaVpc,
    handler: 'apps/workers/src/cron/scheduler.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, researchEngineQueue, fabFileBucket, generatedImagesBucket],
    timeout: '10 minutes',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
  },
});

const agentProactiveMessageCron = new sst.aws.Cron('agentProactiveMessageCron', {
  schedule: 'rate(1 hour)',
  function: {
    vpc: lambdaVpc,
    handler: 'apps/workers/src/cron/agentProactiveMessaging.checkAndScheduleProactiveMessages',
    runtime: 'nodejs24.x',
    link: [...allSecrets, agentProactiveMessageQueue],
    timeout: '10 minutes',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
  },
});

// Unified user activity report function (used by both daily and weekly schedules)
const userActivityReportFunction = new sst.aws.Function('userActivityReportFunction', {
  vpc: lambdaVpc,
  handler: 'apps/workers/src/cron/userActivityReport.handler',
  runtime: 'nodejs24.x',
  timeout: '10 minutes',
  link: [...allSecrets],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
    APP_URL: $dev ? 'http://localhost:3000' : appUrlForLambdaEnv(),
  },
  dev: false,
});

// Daily report - runs every day at 00:00 CST (05:00 UTC)
const dailyUserActivityReport = runsScheduledJobs
  ? new sst.aws.Cron('dailyUserActivityReport', {
      // Expressions are in UTC+0. We want to run it every day at 00:00 CST.
      schedule: 'cron(0 5 * * ? *)',
      job: userActivityReportFunction.arn,
      event: { reportType: 'daily' },
      enabled: $app.stage === 'production',
    })
  : undefined;

// Weekly report - runs every Monday at 00:00 CST (05:00 UTC)
const weeklyUserActivityReport = runsScheduledJobs
  ? new sst.aws.Cron('weeklyUserActivityReport', {
      schedule: 'cron(0 5 ? * MON *)',
      job: userActivityReportFunction.arn,
      event: { reportType: 'weekly' },
      enabled: $app.stage === 'production',
    })
  : undefined;

const signupBaselineReport = runsScheduledJobs
  ? new sst.aws.Cron('signupBaselineReport', {
      schedule: 'cron(0 6 ? * MON *)',
      enabled: $app.stage === 'production',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/signupBaselineReport.handler',
        runtime: 'nodejs24.x',
        timeout: '10 minutes',
        link: [...allSecrets],
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
          SIGNUP_BASELINE_SINCE: process.env.SIGNUP_BASELINE_SINCE || '',
          ANALYTICS_TEST_PATTERN: process.env.ANALYTICS_TEST_PATTERN || '',
        },
        logging: {
          retention: '1 week',
        },
      },
    })
  : undefined;

// Refreshes the disposable email domain lists the signup gate reads. Its SourceFailures metric feeds
// disposableDomainRefreshFailures in alarms.ts.
const disposableDomainRefreshCron = runsScheduledJobs
  ? new sst.aws.Cron('disposableDomainRefresh', {
      schedule: 'cron(30 4 * * ? *)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/disposableDomainRefresh.handler',
        runtime: 'nodejs24.x',
        timeout: '10 minutes',
        memory: '1024 MB',
        // The next daily run is the retry; a failing source keeps its previous entries meanwhile.
        retries: 0,
        link: [...allSecrets],
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
    })
  : undefined;

const youngAccountSpendAlert =
  runsScheduledJobs && youngAccountSpendAlertDeadLetter
    ? new sst.aws.Cron('youngAccountSpendAlert', {
        schedule: 'rate(1 hour)',
        enabled: $app.stage === 'production',
        function: {
          vpc: lambdaVpc,
          handler: 'apps/workers/src/cron/youngAccountSpendAlert.handler',
          runtime: 'nodejs24.x',
          timeout: '2 minutes',
          link: [...allSecrets],
          environment: {
            ...DEFAULT_LAMBDA_ENVIRONMENT,
            YOUNG_ACCOUNT_SPEND_ALERT_CREDITS: process.env.YOUNG_ACCOUNT_SPEND_ALERT_CREDITS || '',
            YOUNG_ACCOUNT_SPEND_ALERT_ACCOUNTS: process.env.YOUNG_ACCOUNT_SPEND_ALERT_ACCOUNTS || '',
          },
          permissions: [youngAccountSpendAlertDeadLetter.sendPermission],
          transform: youngAccountSpendAlertDeadLetter.functionTarget,
          logging: {
            retention: '1 week',
          },
        },
        transform: {
          target: {
            ...youngAccountSpendAlertDeadLetter.ruleTarget.target,
            // SST defaults to a literal {} input; omit it to retain EventBridge's scheduled time.
            // The handler's window, its DLQ message body and replay all depend on it.
            input: undefined,
          },
        },
      })
    : undefined;

if (youngAccountSpendAlert && youngAccountSpendAlertDeadLetter) {
  youngAccountSpendAlertDeadLetter.allowRules([$util.output(youngAccountSpendAlert)]);
}

// Signup Grant Held Release - pays grants held by the daily budget, oldest first, once a new UTC day's
// budget is available. Idempotent per account, so the next hourly run is the retry.
// Self-host twin: apps/workers/src/selfhost/signupGrantHeldRelease.ts.
const signupGrantHeldRelease =
  runsScheduledJobs && signupGrantHeldReleaseDeadLetter
    ? new sst.aws.Cron('signupGrantHeldRelease', {
        schedule: 'rate(1 hour)',
        function: {
          vpc: lambdaVpc,
          handler: 'apps/workers/src/cron/signupGrantHeldRelease.handler',
          runtime: 'nodejs24.x',
          timeout: '5 minutes',
          retries: 0,
          link: [...allSecrets],
          environment: {
            ...DEFAULT_LAMBDA_ENVIRONMENT,
          },
          permissions: [signupGrantHeldReleaseDeadLetter.sendPermission],
          transform: signupGrantHeldReleaseDeadLetter.functionTarget,
          logging: {
            retention: '1 month',
          },
        },
        transform: {
          target: {
            ...signupGrantHeldReleaseDeadLetter.ruleTarget.target,
            input: undefined,
          },
        },
      })
    : undefined;

if (signupGrantHeldRelease && signupGrantHeldReleaseDeadLetter) {
  signupGrantHeldReleaseDeadLetter.allowRules([$util.output(signupGrantHeldRelease)]);
}

const secretRotationNotifierCron = runsScheduledJobs
  ? new sst.aws.Cron('secretRotationNotifier', {
      // Daily check at 9am UTC (4am EST)
      schedule: 'cron(0 9 * * ? *)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/secretRotationNotifier.handler',
        runtime: 'nodejs24.x',
        timeout: '1 minute',
        link: [...allSecrets],
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
        },
      },
    })
  : undefined;

// [DELETION-FOOTPRINT] Team Metrics Refresh cron moved to @bike4mind/premium-pi
// (contributeInfra in packages/premium/pi/src/infra.ts) during the Pi open-core carve.

// API Key Baseline Calculation - runs daily at 2am UTC (9pm CST previous day)
// Calculates normal usage patterns for each user's API keys based on last 30 days
const apiKeyBaselineCalculation = runsScheduledJobs
  ? new sst.aws.Cron('apiKeyBaselineCalculation', {
      schedule: 'cron(0 2 * * ? *)', // Daily at 2am UTC
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/apiKeyBaselineCalculation.handler',
        runtime: 'nodejs24.x',
        timeout: '15 minutes', // May need time for users with many API keys
        link: [...allSecrets],
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
        },
      },
    })
  : undefined;

// Read-only usage pattern signals for free-tier review; a no-op until usagePatternSignalsEnabled is on.
const usagePatternSignals = runsScheduledJobs
  ? new sst.aws.Cron('usagePatternSignals', {
      schedule: 'rate(1 hour)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/usagePatternSignals.handler',
        runtime: 'nodejs24.x',
        timeout: '10 minutes',
        link: [...allSecrets],
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
        },
        logging: {
          retention: '1 week',
        },
      },
    })
  : undefined;

// Email campaign scheduler - runs every 5 minutes to check for scheduled campaigns
const emailCampaignSchedulerCron = new sst.aws.Cron('emailCampaignScheduler', {
  schedule: 'rate(5 minutes)',
  function: {
    vpc: lambdaVpc,
    handler: 'apps/workers/src/cron/emailCampaignScheduler.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, emailJobQueue],
    timeout: '2 minutes',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
  },
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
const liveopsTriageDispatcherCron = runsScheduledJobs
  ? new sst.aws.Cron('liveopsTriageDispatcherCron', {
      schedule: 'cron(0 2,8,14,20 * * ? *)', // Every 6 hours UTC
      function: {
        handler: 'apps/workers/src/cron/liveopsTriageDispatcher.handler',
        vpc: lambdaVpc,
        link: [...allSecrets, liveOpsTriageQueue],
        timeout: '2 minutes',
        runtime: 'nodejs24.x',
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
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
    })
  : undefined;

// Telemetry TTL Cleanup — GDPR Article 5(1)(e) storage limitation
// Removes contextTelemetry from Quest documents older than 90 days
const telemetryCleanupCron = runsScheduledJobs
  ? new sst.aws.Cron('telemetryCleanup', {
      schedule: 'cron(0 3 * * ? *)', // Daily at 3am UTC
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/telemetryCleanup.handler',
        runtime: 'nodejs24.x',
        timeout: '10 minutes',
        link: [...allSecrets],
        environment: { ...DEFAULT_LAMBDA_ENVIRONMENT },
      },
    })
  : undefined;

// Signup IP retention - truncates User.signupMeta.ip to its /24 (IPv4) or /48 (IPv6) prefix once
// the signup is older than the AuthEvent TTL (90 days)
const signupIpRetentionCron = runsScheduledJobs
  ? new sst.aws.Cron('signupIpRetention', {
      schedule: 'cron(30 3 * * ? *)', // Daily at 3:30am UTC
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/signupIpRetention.handler',
        runtime: 'nodejs24.x',
        timeout: '10 minutes',
        link: [...allSecrets],
        environment: { ...DEFAULT_LAMBDA_ENVIRONMENT },
      },
    })
  : undefined;

// Credit Lot Sweep — reconciles the CreditLot parallel ledger against
// currentCredits: assigns cumulative consumption soonest-to-expire-first and
// expires stale remainders (see #190 design).
const creditLotSweepCron = runsScheduledJobs
  ? new sst.aws.Cron('creditLotSweep', {
      schedule: 'cron(0 4 * * ? *)', // Daily at 4am UTC
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/creditLotSweep.handler',
        runtime: 'nodejs24.x',
        timeout: '10 minutes',
        link: [...allSecrets],
        environment: { ...DEFAULT_LAMBDA_ENVIRONMENT },
      },
    })
  : undefined;

// Voice Hold Sweep - settles voice credit holds no client ever ended (closed tab, crashed browser,
// failed connect) on connected time. Self-host twin: apps/workers/src/selfhost/voiceHoldSweep.ts;
// keep the schedules in step. Settlement is DB-only and capped at VOICE_HOLD_SWEEP_LIMIT holds per
// run. Overlapping runs (at-least-once delivery) are safe because settleVoiceHold claims each hold
// atomically, so a losing settler moves no credit.
const voiceHoldSweepCron = runsScheduledJobs
  ? new sst.aws.Cron('voiceHoldSweep', {
      schedule: 'rate(5 minutes)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/voiceHoldSweep.handler',
        runtime: 'nodejs24.x',
        timeout: '4 minutes',
        // The 5-minute schedule is the retry; Lambda's async retries would land one failed run in two alarm periods.
        retries: 0,
        link: [...allSecrets],
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
        },
        // The stale-hold alarms in infra/alarms.ts watch the counts this function publishes.
        permissions: [
          {
            actions: ['cloudwatch:PutMetricData'],
            resources: ['*'],
          },
        ],
        logging: {
          retention: '1 week',
        },
      },
    })
  : undefined;

// Admin Audit Alerts - posts critical Admin Audit Log entries and credit-grant bursts to the security
// Slack webhook (AdminSettings SlackSecurityAlertsWebhookUrl; unset = off). The stored cursor only
// advances past posted entries, so the next minute's run is the retry. APP_URL builds the entry links.
// Self-host twin: apps/workers/src/selfhost/adminAuditAlerts.ts.
const adminAuditAlertsCron = runsScheduledJobs
  ? new sst.aws.Cron('adminAuditAlerts', {
      schedule: 'rate(1 minute)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/adminAuditAlerts.handler',
        runtime: 'nodejs24.x',
        timeout: '50 seconds',
        // The next minute's run is the retry; Lambda's async retries would overlap it.
        retries: 0,
        link: [...allSecrets],
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
          APP_URL: $dev ? 'http://localhost:3000' : appUrlForLambdaEnv(),
        },
        logging: {
          retention: '1 month',
        },
      },
    })
  : undefined;

// OAuth Abuse Auto-Block - blocks IPs whose failed OAuth sign-ins reach the admin-set threshold, with
// escalating durations. The admin evaluate endpoint runs the same code on demand.
// Self-host twin: apps/workers/src/selfhost/oauthAbuseAutoBlock.ts; keep the schedules in step.
const oauthAbuseAutoBlockCron = runsScheduledJobs
  ? new sst.aws.Cron('oauthAbuseAutoBlockCron', {
      schedule: 'rate(1 minute)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/oauthAbuseAutoBlock.handler',
        runtime: 'nodejs24.x',
        timeout: '50 seconds',
        // The next minute's run is the retry; Lambda's async retries would overlap it.
        retries: 0,
        link: [...allSecrets],
        environment: DEFAULT_LAMBDA_ENVIRONMENT,
        logging: {
          retention: '1 month',
        },
      },
    })
  : undefined;

// Data Lake Vector Index Keep-Warm - one wide $vectorSearch per queryable per-model Atlas index, so
// forced retrieval's 3s ANN candidate pick does not hit a cold index after an idle stretch
// and fall back to picking files by name. Skips itself while EnableDataLakeVectorSearch is off.
// No self-host twin: self-host retrieval runs on OpenSearch.
const dataLakeVectorIndexKeepWarmCron = runsScheduledJobs
  ? new sst.aws.Cron('dataLakeVectorIndexKeepWarm', {
      schedule: 'rate(5 minutes)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/dataLakeVectorIndexKeepWarm.handler',
        runtime: 'nodejs24.x',
        // A query against an index that has already gone cold has taken 49s on production.
        timeout: '2 minutes',
        // The next run is the retry; Lambda's async retries would only stack more queries on mongot.
        retries: 0,
        link: [...allSecrets],
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
        },
        logging: {
          retention: '1 month',
        },
      },
    })
  : undefined;

// Credit Hold Sweep - refunds request credit holds whose process died between reserve and settle.
// Self-host twin: apps/workers/src/selfhost/creditHoldSweep.ts; keep the schedules in step.
// Overlapping runs are safe: each hold's claim and refund commit in one transaction.
const creditHoldSweepCron = runsScheduledJobs
  ? new sst.aws.Cron('creditHoldSweep', {
      schedule: 'rate(15 minutes)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/creditHoldSweep.handler',
        runtime: 'nodejs24.x',
        timeout: '2 minutes',
        link: [...allSecrets],
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
        },
        permissions: [
          {
            actions: ['cloudwatch:PutMetricData'],
            resources: ['*'],
          },
        ],
        logging: {
          retention: '1 week',
        },
      },
    })
  : undefined;

// Integration Health Check - runs every 5 minutes to probe external APIs
// Probes: Slack, GitHub, Jira, Confluence
const integrationHealthCheckCron = runsScheduledJobs
  ? new sst.aws.Cron('integrationHealthCheck', {
      schedule: 'rate(5 minutes)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/integrationHealthCheck.handler',
        runtime: 'nodejs24.x',
        timeout: '2 minutes',
        link: [...allSecrets],
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
    })
  : undefined;

// Cloud Security Scan - runs daily to evaluate baseline AWS configuration
const cloudSecurityScanCron = runsScheduledJobs
  ? new sst.aws.Cron('CloudSecurityScan', {
      schedule: 'rate(1 day)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/security/cloudScan.handler',
        runtime: 'nodejs24.x',
        timeout: '5 minutes',
        link: [...allSecrets],
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
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
    })
  : undefined;

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
const securityScanSchedulerCron = runsScheduledJobs
  ? new sst.aws.Cron('securityScanScheduler', {
      schedule: 'rate(1 hour)', // Check every hour
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/securityScanScheduler.handler',
        runtime: 'nodejs24.x',
        link: [...allSecrets],
        timeout: '5 minutes',
        memory: '512 MB',
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
        },
      },
    })
  : undefined;

// Deep Agent Wake Scheduler — scans for agents whose next wake is due
// (handoff.nextWakeAt <= now) and enqueues a wake per agent.
const deepAgentWakeCron = runsScheduledJobs
  ? new sst.aws.Cron('deepAgentWakeCron', {
      schedule: 'rate(5 minutes)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/deepAgentWake.handler',
        runtime: 'nodejs24.x',
        link: [...allSecrets, deepAgentWakeQueue],
        timeout: '2 minutes',
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
        },
      },
    })
  : undefined;

// Loop scheduler - folds finished loop runs back into their loops, then dispatches due live loops
// as headless agent executions. Idles (claims nothing) while the EnableLoops admin setting is off.
const loopSchedulerCron =
  runsLoopScheduler && loopSchedulerDeadLetter
    ? new sst.aws.Cron('loopSchedulerCron', {
        schedule: 'rate(5 minutes)',
        function: {
          vpc: lambdaVpc,
          handler: 'apps/workers/src/cron/loopScheduler.handler',
          runtime: 'nodejs24.x',
          timeout: '2 minutes',
          // startAgentExecution resolves the executor through the AgentExecutor link.
          link: [...allSecrets, agentExecutor],
          environment: {
            ...DEFAULT_LAMBDA_ENVIRONMENT,
          },
          permissions: [
            loopSchedulerDeadLetter.sendPermission,
            { actions: ['lambda:InvokeFunction'], resources: [agentExecutor.arn] },
          ],
          transform: loopSchedulerDeadLetter.functionTarget,
          logging: {
            retention: '1 week',
          },
        },
        transform: {
          target: {
            ...loopSchedulerDeadLetter.ruleTarget.target,
            // SST defaults to a literal {} input; omit it to retain EventBridge's scheduled time.
            input: undefined,
          },
        },
      })
    : undefined;

if (loopSchedulerCron && loopSchedulerDeadLetter) {
  loopSchedulerDeadLetter.allowRules([$util.output(loopSchedulerCron)]);
}

// Data Lake Research Schedule - fires research configs whose cadence is due, skipping any lake whose
// pending-proposal queue is at the config's review limit. 15 minutes is plenty for a daily-at-most
// cadence; self-host drives the same tick from apps/workers/src/selfhost/main.ts.
const dataLakeResearchScheduleCron = runsScheduledJobs
  ? new sst.aws.Cron('dataLakeResearchScheduleCron', {
      schedule: 'rate(15 minutes)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/dataLakeResearchSchedule.handler',
        runtime: 'nodejs24.x',
        link: [...allSecrets, dataLakeResearchQueue],
        timeout: '2 minutes',
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
        },
      },
    })
  : undefined;

/**
 * SRE Stale Dispatch Cleanup
 * Detects dispatches stuck in 'fixing' status (>60 minutes) and transitions them to 'failed'.
 *
 * Schedule: Every 15 minutes
 * Enabled: production and dev environments
 */
const sreStaleDispatchCron = runsScheduledJobs
  ? new sst.aws.Cron('SreStaleDispatchCron', {
      schedule: 'rate(15 minutes)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/sreStaleDispatch.handler',
        runtime: 'nodejs24.x',
        link: [...allSecrets],
        timeout: '2 minutes',
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
        },
      },
    })
  : undefined;

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
  handler: 'apps/workers/src/security/attackSimulation/runner.handler',
  vpc: lambdaVpc,
  link: [...allSecrets],
  timeout: '14 minutes',
  memory: '512 MB',
  runtime: 'nodejs24.x',
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
});

const attackSimulationCron = runsScheduledJobs
  ? new sst.aws.Cron('attackSimulationCron', {
      schedule: 'cron(0 6 ? * SUN *)', // Sunday 06:00 UTC
      job: attackSimulationFunction.arn,
      event: { trigger: 'scheduled' },
    })
  : undefined;

/**
 * Model Discovery
 *
 * Refreshes the model catalog from provider APIs and aggregators. Standalone
 * Lambda + `event` payload so an admin "Run now" can InvokeAsync the same ARN
 * with `{ trigger: 'manual' }`, exactly like attackSimulation above.
 *
 * Timeout is 10 minutes rather than 5 because Bedrock availability is a
 * per-model call over ~300 foundation models; the run's own global deadline
 * (timeout minus a minute) is what actually ends a run, and it commits what
 * finished. The timeout is the backstop, not the error handler.
 */
const modelDiscoveryFunction = new sst.aws.Function('modelDiscoveryFunction', {
  vpc: lambdaVpc,
  handler: 'apps/workers/src/cron/modelDiscovery.handler',
  runtime: 'nodejs24.x',
  timeout: '10 minutes',
  // Both entry points are async invokes, so Lambda's default of 2 retries would
  // re-issue the whole provider fan-out twice more on a failing run. A discovery
  // run is not idempotent-cheap; the 6h cron below is the real retry.
  retries: 0,
  link: [...allSecrets],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  permissions: [
    {
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    },
    {
      actions: ['bedrock:ListFoundationModels', 'bedrock:GetFoundationModelAvailability'],
      resources: ['*'],
    },
  ],
});

/**
 * Stage-differentiated anchors instead of `rate(6 hours)`.
 *
 * dev and production share provider accounts and egress the same NAT, and a
 * rate() schedule is anchored to whenever the rule was created - two stages
 * deployed close together arrive at every provider simultaneously, forever, and
 * nothing in the expression says otherwise. Fixed anchors 3h30m apart make the
 * separation explicit and reviewable. The service's per-source minimum-interval
 * guard is the backstop that also covers a manual run landing next to a
 * scheduled one; jitter is deliberately NOT implemented as a sleep, which would
 * bill Lambda time to do nothing.
 *
 * Minute offsets (:20 / :50) also keep discovery off the top of the hour, where
 * every other cron in this file starts.
 */
const MODEL_DISCOVERY_SCHEDULE_BY_STAGE: Record<string, `cron(${string})`> = {
  production: 'cron(20 0,6,12,18 * * ? *)', // 00:20, 06:20, 12:20, 18:20 UTC
  dev: 'cron(50 3,9,15,21 * * ? *)', // 03:50, 09:50, 15:50, 21:50 UTC
};

// The no-successful-run alarm in alarms.ts keys off this too; keep one source. Preview stages never hammer providers.
const modelDiscoveryCronEnabled = runsScheduledJobs;

const modelDiscoveryCron = modelDiscoveryCronEnabled
  ? new sst.aws.Cron('modelDiscoveryCron', {
      schedule: MODEL_DISCOVERY_SCHEDULE_BY_STAGE[$app.stage] ?? MODEL_DISCOVERY_SCHEDULE_BY_STAGE.production,
      job: modelDiscoveryFunction.arn,
      event: { trigger: 'cron' },
    })
  : undefined;

// Independent of modelDiscoveryCron: the check must still run when discovery stops.
const modelDiscoveryStalenessFunction = new sst.aws.Function('modelDiscoveryStalenessFunction', {
  vpc: lambdaVpc,
  handler: 'apps/workers/src/cron/modelDiscoveryStaleness.handler',
  runtime: 'nodejs24.x',
  timeout: '2 minutes',
  link: [...allSecrets],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  permissions: [
    {
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    },
  ],
});

const modelDiscoveryStalenessCron = modelDiscoveryCronEnabled
  ? new sst.aws.Cron('modelDiscoveryStalenessCron', {
      schedule: 'rate(15 minutes)',
      job: modelDiscoveryStalenessFunction.arn,
    })
  : undefined;

/**
 * Data Lake Batch Reconcile (daily fallback)
 * Global watchdog: forces batches stuck non-terminal past the timeout to terminal via the same
 * guarded reconciler as the read-time path, so a batch that goes stuck while nobody opens their
 * batch list still terminalizes.
 *
 * Schedule: daily (5am UTC)
 * Enabled: production + dev
 */
const dataLakeBatchReconcileCron = runsScheduledJobs
  ? new sst.aws.Cron('dataLakeBatchReconcile', {
      schedule: 'cron(0 5 * * ? *)', // Daily at 5am UTC (after telemetry 3am / creditLot 4am)
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/dataLakeBatchReconcile.handler',
        runtime: 'nodejs24.x',
        timeout: '10 minutes',
        // dataLakeTaxonomyQueue + websocketApi: the stuck-batch backstop calls
        // enqueueTaxonomyAnalysisIfWanted, which needs Resource.dataLakeTaxonomyQueue.url to
        // enqueue and, on a rate-limited batch, Resource.websocket.managementEndpoint to push the
        // live status update. fabFileChunkQueue: the un-chunked rescue sweep re-enqueues
        // complete-but-never-chunked files for chunking. fabFileBucket: the moderation rescue sweep
        // downloads stranded files to re-run the image scan.
        link: [...allSecrets, dataLakeTaxonomyQueue, websocketApi, fabFileChunkQueue, fabFileBucket],
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
        },
        permissions: [
          {
            actions: ['cloudwatch:PutMetricData'],
            resources: ['*'],
          },
          // The moderation rescue sweep re-runs the image scan on stranded files.
          {
            actions: ['rekognition:DetectModerationLabels'],
            resources: ['*'],
          },
        ],
      },
    })
  : undefined;

/**
 * Quest Timeout Sweep
 * Server-side backstop for quests stuck at `status: 'running'` past the
 * liveness threshold (120s). The read-time recovery in GET /api/quests/[id]
 * handles polling API clients, but a quest no client ever reads again stays
 * stuck without this cron. Uses the same pure decision function as the read
 * path (resolveQuestTimeoutRecovery).
 *
 * Schedule: every 5 minutes
 * Enabled: production + dev
 */
const questTimeoutSweepCron = runsScheduledJobs
  ? new sst.aws.Cron('questTimeoutSweep', {
      schedule: 'rate(5 minutes)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/questTimeoutSweep.handler',
        runtime: 'nodejs24.x',
        // generationCallbackQueue: a timed-out image/video generation job still owes its caller a
        // completion callback, so the sweep enqueues one when it recovers a stuck quest.
        link: [...allSecrets, generationCallbackQueue],
        timeout: '2 minutes',
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
    })
  : undefined;

/**
 * Generation Job Sweep
 * Re-enqueues generation jobs whose SQS message was lost or whose worker died mid-step.
 *
 * Schedule: every 5 minutes
 * Enabled: every stage, so previews and staging (where the test provider runs) get recovery too; it is a
 * no-op when nothing is stalled.
 * Self-host: apps/workers/src/selfhost/generationJobSweep.ts
 */
const generationJobSweepCron = new sst.aws.Cron('generationJobSweep', {
  schedule: 'rate(5 minutes)',
  function: {
    vpc: lambdaVpc,
    handler: 'apps/workers/src/cron/generationJobSweep.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, generationJobQueue],
    timeout: '2 minutes',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
  },
});

/**
 * Skill Market Review SLA
 * Reminds authors and reviewers about Skill Market versions held for human review past the
 * SkillMarketReviewSlaHours admin setting. Never approves anything.
 *
 * Schedule: daily
 * Enabled: every stage (a no-op when nothing is overdue)
 * Self-host: apps/workers/src/selfhost/skillMarketReviewSla.ts
 */
const skillMarketReviewSlaCron = new sst.aws.Cron('skillMarketReviewSla', {
  schedule: 'rate(1 day)',
  function: {
    vpc: lambdaVpc,
    handler: 'apps/workers/src/cron/skillMarketReviewSla.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets],
    timeout: '2 minutes',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
  },
});

/**
 * Realtime Connection Sweep
 * Revoke paths mark a WebSocket connection ended (subscribers pulled, row kept); this sweep owns
 * the socket close. It ends live connections whose credential no longer holds (token expired past
 * grace, session revoked, tokenVersion bumped, account blocked, API key inactive), closes every
 * ended connection's socket through the management API, and deletes the row once the close
 * succeeded or the socket was already gone. A failed close keeps the ended row for the next run;
 * an ended row older than any socket can live is deleted regardless. It also removes query
 * subscribers whose connection row is missing or ended.
 *
 * Schedule: every 5 minutes
 * Enabled: every stage; a no-op when nothing has lapsed.
 * Self-host: apps/workers/src/selfhost/realtimeConnectionSweep.ts
 */
const realtimeConnectionSweepCron = new sst.aws.Cron('realtimeConnectionSweep', {
  schedule: 'rate(5 minutes)',
  function: {
    vpc: lambdaVpc,
    handler: 'apps/workers/src/cron/realtimeConnectionSweep.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, websocketApi],
    timeout: '2 minutes',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    // DeleteConnection on the sockets it ends.
    permissions: [
      {
        actions: ['execute-api:ManageConnections'],
        resources: ['*'],
      },
    ],
  },
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
const agentExecutionAbandonedSweepCron = runsScheduledJobs
  ? new sst.aws.Cron('agentExecutionAbandonedSweep', {
      schedule: 'rate(1 hour)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/agentExecutionAbandonedSweep.handler',
        runtime: 'nodejs24.x',
        link: [...allSecrets],
        timeout: '2 minutes',
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
    })
  : undefined;

// Spend Reconciliation -- fetches authoritative billing from Anthropic/OpenAI
// admin APIs and compares against internal COGS estimates.
const spendReconciliationCron = runsScheduledJobs
  ? new sst.aws.Cron('spendReconciliation', {
      schedule: 'cron(0 6 * * ? *)', // Daily at 6am UTC
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/spendReconciliation.handler',
        runtime: 'nodejs24.x',
        timeout: '5 minutes',
        link: [...allSecrets],
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
        },
      },
    })
  : undefined;

// Credit Purchase Reconciliation -- alerts on Stripe credit purchases that
// succeeded with no credit grant.
const creditPurchaseReconciliationCron = runsScheduledJobs
  ? new sst.aws.Cron('creditPurchaseReconciliation', {
      schedule: 'cron(0 7 * * ? *)', // Daily at 7am UTC
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/creditPurchaseReconciliation.handler',
        runtime: 'nodejs24.x',
        timeout: '5 minutes',
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
    })
  : undefined;

// Storage Reconciliation -- compares each user's currentStorageSize with the bytes their charged
// files hold, records drift and alerts over threshold. Dry run unless STORAGE_RECONCILIATION_REPAIR
// is 'true'; a daily pass resumes across hourly invocations.
const storageReconciliationCron = runsScheduledJobs
  ? new sst.aws.Cron('storageReconciliation', {
      schedule: 'rate(1 hour)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/storageReconciliation.handler',
        runtime: 'nodejs24.x',
        timeout: '5 minutes',
        link: [...allSecrets],
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
          STORAGE_RECONCILIATION_REPAIR: 'false',
          // The cron's alert thresholds, named here so tuning them does not require a code change.
          STORAGE_DRIFT_ALERT_BYTES: String(100 * 1024 * 1024),
          STORAGE_DRIFTED_USER_CEILING: '50',
          STORAGE_DRIFT_CEILING_MIN_BYTES: String(1024 * 1024),
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
    })
  : undefined;

/**
 * Drive-as-Lake Re-sync Poll (#1591 E1)
 * Re-enqueues each due Google Drive connection onto the ingest handler, which diffs the folder
 * against its data lake and applies adds/edits/removals. Dark until both EnableDataLakes and
 * EnableDataLakeDrivePoll admin flags are on (the handler enforces the gate).
 *
 * Schedule: hourly (connections are re-polled at most every ~6h; see DRIVE_LAKE_POLL_INTERVAL_MS in
 * packages/server-utils/src/integrations/google/drive/drivePollSchedule.ts)
 * Enabled: production + dev
 */
const driveLakeResyncPollCron = runsScheduledJobs
  ? new sst.aws.Cron('driveLakeResyncPoll', {
      schedule: 'rate(1 hour)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/driveLakeResyncPoll.handler',
        runtime: 'nodejs24.x',
        timeout: '2 minutes',
        // driveLakeIngestQueue: the poll enqueues each due connection onto the shared ingest handler,
        // so it needs Resource.driveLakeIngestQueue.url and the sqs:SendMessage grant the link provides.
        link: [...allSecrets, driveLakeIngestQueue],
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
        },
      },
    })
  : undefined;

/**
 * GitHub-as-Lake Reconcile
 * Compares each connected repository's default-branch HEAD with its last synced commit and
 * enqueues the ingest handler on a mismatch, so a missed push webhook is still picked up. Dark
 * until the EnableDataLakes, EnableDataLakeGitHub and EnableDataLakeGitHubReconcile admin flags
 * are all on (the handler enforces the gate).
 *
 * Schedule: every 15 minutes (a bounded batch of connections per run; see MAX_CHECKS_PER_RUN in the handler)
 * Enabled: production + dev
 */
const githubLakeReconcileCron = runsScheduledJobs
  ? new sst.aws.Cron('githubLakeReconcile', {
      schedule: 'rate(15 minutes)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/githubLakeReconcile.handler',
        runtime: 'nodejs24.x',
        timeout: '5 minutes',
        // githubLakeIngestQueue: a changed HEAD is enqueued onto the shared ingest handler, so the
        // cron needs Resource.githubLakeIngestQueue.url and the sqs:SendMessage grant the link provides.
        link: [...allSecrets, githubLakeIngestQueue],
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
        },
      },
    })
  : undefined;

/**
 * Data-Lake Connector Orphan Reap
 * Releases Drive connections and GitHub bindings whose data lake document no longer exists, so their
 * globally unique folder / repository claims do not outlive the lake. Gated on EnableDataLakes only
 * (cleanup runs even with polling off); the GitHub leg also needs EnableDataLakeGitHub (the handler
 * enforces both).
 *
 * Schedule: daily (a bounded batch per connector; see MAX_REAPS_PER_CONNECTOR in the handler)
 * Enabled: production + dev
 */
const lakeConnectorOrphanReapCron = runsScheduledJobs
  ? new sst.aws.Cron('lakeConnectorOrphanReap', {
      schedule: 'rate(1 day)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/lakeConnectorOrphanReap.handler',
        runtime: 'nodejs24.x',
        timeout: '5 minutes',
        // githubLakeRevokeQueue: releasing a GitHub binding hands a failed post-release uninstall to it
        // (releaseGitHubLakeConnection, githubLakeConnection.ts).
        link: [...allSecrets, githubLakeRevokeQueue],
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
        },
      },
    })
  : undefined;

/**
 * system-help data-lake re-sync
 * Mirrors the public help corpus into the `system-help` lake - the corpus behind in-chat
 * `search_knowledge_base`. Previously this only ever ran when someone remembered to invoke
 * `help:ingest-datalake` through `sst shell`, so the lake drifted from the shipped docs in both
 * directions (missing new articles, still serving deleted ones).
 *
 * The mirror is differential (see the shared ingestHelpDatalake), so a tick on an unchanged corpus
 * writes nothing and spends nothing on embeddings; only a deploy that moved the docs costs anything.
 * Does NOT bootstrap: with no lake row the handler no-ops, because the lake's `createdByUserId` is
 * the file owner and whose LLM keys embed the chunks.
 *
 * copyFiles carries the corpus into the bundle as `docs-site/docs` plus `help-index.json`. MUST
 * STAY IN SYNC with CORPUS_DIR in the handler.
 *
 * The index is generated, not committed, and it is generated HERE rather than relied on from
 * elsewhere. `apps/client`'s prebuild also produces it, but that belongs to the web component's
 * `next build` and nothing orders that before this function is bundled, so depending on it would
 * be a race that fails as a missing copyFiles source. Regenerating is keyless, deterministic and
 * takes about a third of a second, so doing it unconditionally is cheaper than the coupling.
 *
 * The cost of putting it at module scope: this file is re-exported from infra/index.ts, so EVERY
 * SST command that loads the program pays it - `remove` and `diff` included - and `buildHelpIndex`
 * throws on an empty corpus. A deployer checkout without docs-site, or without the workspace
 * installed, therefore fails to load the program at all rather than failing only to deploy.
 * That is the right trade for `deploy` and the wrong one for `remove`; it is accepted here
 * because the alternative (deriving the index inside the handler and copying only docs-site)
 * is a larger change than this one.
 *
 * HELP_CORPUS_VERSION exists only to make a docs-only edit redeploy the function: SST does not
 * notice copyFiles CONTENT changes, so without it the bundle keeps the corpus from whenever the
 * handler last changed and this cron converges the lake onto stale docs on a 6-hour loop, silently.
 * Same workaround, same shape as MCP_VERSION in infra/mcp.ts.
 *
 * Schedule: every 6 hours, so a docs change lands in the lake the same day it deploys.
 * Enabled: production + dev
 */
execSync('pnpm --filter @bike4mind/scripts help:build-index', { stdio: 'inherit' });

// Hashes the index's BYTES, not a git blob: it is no longer tracked, so `git ls-tree` cannot see
// it. The computation lives in @bike4mind/infra because nothing imports this file, so that is the
// only place its failure modes can be tested - see helpCorpusHash.ts for which ones and why.
const HELP_CORPUS_HASH = computeHelpCorpusHash({
  readDocsTree: () => execFileSync('git', ['ls-tree', '-r', 'HEAD', 'docs-site/docs']).toString(),
  readIndex: () => readFileSync('apps/client/app/generated/help-index.json'),
});

const helpDatalakeIngestCron = runsScheduledJobs
  ? new sst.aws.Cron('helpDatalakeIngest', {
      schedule: 'rate(6 hours)',
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/helpDatalakeIngest.handler',
        runtime: 'nodejs24.x',
        // Generous: a first run after a docs-wide edit re-embeds the whole corpus one chunk at a
        // time. The steady state is a few seconds; the handler's own per-run create cap is what
        // keeps a pathological corpus from reaching this ceiling.
        timeout: '15 minutes',
        link: [...allSecrets],
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
          HELP_CORPUS_VERSION: HELP_CORPUS_HASH,
        },
        copyFiles: [
          { from: 'docs-site/docs', to: 'help-corpus/docs' },
          { from: 'apps/client/app/generated/help-index.json', to: 'help-corpus/help-index.json' },
        ],
        // This cron embeds the whole help corpus through createHelpEmbedder, so it needs the same
        // Bedrock grant the vectorize subscriber has (infra/queues.ts): an admin can point
        // defaultEmbeddingModel at Titan, and a stage with no provider key falls back to it. Without
        // this the first tick AccessDenies on every chunk and retries the whole corpus every 6 hours.
        permissions: [
          {
            actions: ['bedrock:InvokeModel'],
            resources: ['*'],
          },
        ],
      },
    })
  : undefined;

/**
 * Lake Health Sweep - scheduled counterpart to the on-demand GET /api/data-lakes/:id/health.
 * Computes computeLakeHealth for every active lake and persists one row per lake per day, so a
 * degrading lake is visible as a trend instead of only when someone opens it.
 *
 * Schedule: daily, after dataLakeBatchReconcile (5am UTC) so a batch that reconciler just forced
 * terminal is reflected in the same day's health.
 */
const lakeHealthSweepCron = runsScheduledJobs
  ? new sst.aws.Cron('lakeHealthSweep', {
      schedule: 'cron(0 6 * * ? *)', // Daily at 6am UTC
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/lakeHealthSweep.handler',
        runtime: 'nodejs24.x',
        timeout: '10 minutes',
        link: [...allSecrets],
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
    })
  : undefined;

/**
 * Scheduled cross-document inconsistency detection over every active lake.
 *
 * Detection used to run only when a curator asked for it, so a contradiction appearing between
 * visits stayed invisible. This grades every active lake on a schedule and persists each problem as
 * a finding ROW, keyed so a repeat detection updates the existing row rather than duplicating it.
 * Detect-only: nothing here gates ingest or removes content.
 *
 * Timeout is 15 minutes rather than the health sweep's 10: one pass reads up to 1000 chunk
 * documents. The handler does not rely on this timeout to stop it - it holds its own wall-clock
 * budget (RUN_BUDGET_MS) and stops a page short, so a long run reports a deferred remainder rather
 * than being killed mid-write with only its first metric emitted.
 *
 * Schedule: daily at 4am UTC, BEFORE lakeHealthSweep (6am) - health renders the stored
 * inconsistency summary rather than computing it, so the other order would make every daily health
 * snapshot report counts a day old.
 */
const lakeInconsistencySweepCron = runsScheduledJobs
  ? new sst.aws.Cron('lakeInconsistencySweep', {
      schedule: 'cron(0 4 * * ? *)', // Daily at 4am UTC
      function: {
        vpc: lambdaVpc,
        handler: 'apps/workers/src/cron/lakeInconsistencySweep.handler',
        runtime: 'nodejs24.x',
        timeout: '15 minutes',
        link: [...allSecrets],
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
    })
  : undefined;

export {
  adminAuditAlertsCron,
  oauthAbuseAutoBlockCron,
  signupGrantHeldRelease,
  disposableDomainRefreshCron,
  dataLakeVectorIndexKeepWarmCron,
  modelDiscoveryCronEnabled,
  dailyUserActivityReport,
  weeklyUserActivityReport,
  signupBaselineReport,
  youngAccountSpendAlert,
  secretRotationNotifierCron,
  scheduleTaskCron,
  apiKeyBaselineCalculation,
  usagePatternSignals,
  agentProactiveMessageCron,
  emailCampaignSchedulerCron,
  liveopsTriageDispatcherCron,
  cloudSecurityScanCron,
  integrationHealthCheckCron,
  securityScanSchedulerCron,
  deepAgentWakeCron,
  loopSchedulerCron,
  dataLakeResearchScheduleCron,
  telemetryCleanupCron,
  signupIpRetentionCron,
  creditLotSweepCron,
  voiceHoldSweepCron,
  creditHoldSweepCron,
  sreStaleDispatchCron,
  attackSimulationFunction,
  attackSimulationCron,
  modelDiscoveryFunction,
  modelDiscoveryCron,
  modelDiscoveryStalenessFunction,
  modelDiscoveryStalenessCron,
  questTimeoutSweepCron,
  generationJobSweepCron,
  skillMarketReviewSlaCron,
  realtimeConnectionSweepCron,
  agentExecutionAbandonedSweepCron,
  dataLakeBatchReconcileCron,
  spendReconciliationCron,
  creditPurchaseReconciliationCron,
  storageReconciliationCron,
  driveLakeResyncPollCron,
  githubLakeReconcileCron,
  lakeConnectorOrphanReapCron,
  helpDatalakeIngestCron,
  lakeHealthSweepCron,
  lakeInconsistencySweepCron,
};

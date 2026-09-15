/**
 * LiveOps Triage Worker
 *
 * Processes individual triage jobs from the SQS queue. Each job corresponds
 * to a single LiveOpsTriageConfig and runs independently.
 *
 * Features:
 * - Idempotency via lastRunStartedAt timestamp comparison
 * - Circuit breaker pattern via consecutiveFailures counter
 * - Progress tracking via LiveopsTriageRun model
 * - Support for both cron-triggered and manual runs
 *
 * Triggered by: SQS liveOpsTriageQueue
 */

import { SQSEvent, Context } from 'aws-lambda';
import { registerLambdaErrorHandlers } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import {
  connectDB,
  liveopsTriageConfigRepository,
  liveopsTriageRunRepository,
  ILiveopsTriageDryRunResult,
} from '@bike4mind/database';
import { Config } from '@server/utils/config';
import { createLiveopsTriageService, sanitizeErrorMessage } from '@server/services/liveopsTriageService';
import { createIssueTracker } from '@server/services/issueTrackers';
import { resolveSlackBotToken } from '@server/services/liveopsConnectionResolver';
import { emitMetric } from '@server/utils/cloudwatch';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { dispatchWithLogger } from '../queueHandlers/utils';
import { Resource } from 'sst';
import { z } from 'zod';
import type { LiveOpsTriageJobMessage } from './liveopsTriageDispatcher';

// Register global handlers to absorb transient network errors (TypeError: terminated)
// that escape try/catch via orphaned undici promises.
registerLambdaErrorHandlers();

const CLOUDWATCH_NAMESPACE = 'Lumina5/LiveOpsTriage';
const CIRCUIT_BREAKER_THRESHOLD = 5; // Auto-disable after 5 consecutive failures
const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const PROGRESS_UPDATE_INTERVAL_MS = 2000; // Throttle progress updates

// Schema validation for SQS messages
const LiveOpsTriageJobMessageSchema = z.object({
  configId: z.string().min(1),
  configName: z.string().min(1),
  dispatchedAt: z.number(),
  source: z.enum(['cron', 'manual']),
  dryRun: z.boolean().optional(),
  lookbackHours: z.number().int().min(1).max(168).optional(),
});

export const handler = dispatchWithLogger(async (event: SQSEvent, _context: Context, logger: Logger) => {
  const stage = Resource.App.stage;

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage));

  const record = event.Records[0];
  if (!record) {
    logger.error('[LIVEOPS-WORKER] No message in SQS event');
    return;
  }

  let message: LiveOpsTriageJobMessage;
  try {
    const parsed = JSON.parse(record.body);
    message = LiveOpsTriageJobMessageSchema.parse(parsed);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('[LIVEOPS-WORKER] Invalid SQS message format', { error: errorMessage, body: record.body });
    // Don't retry malformed messages - they'll never succeed
    return;
  }

  const { configId, configName, dispatchedAt, source, dryRun = false, lookbackHours: messageLookbackHours } = message;
  const startTime = Date.now();

  logger.info('[LIVEOPS-WORKER] Processing triage job', {
    configId,
    configName,
    source,
    dryRun,
    dispatchedAt: new Date(dispatchedAt).toISOString(),
  });

  const config = await liveopsTriageConfigRepository.findById(configId);
  if (!config) {
    logger.warn('[LIVEOPS-WORKER] Config not found, may have been deleted', { configId, configName });
    return;
  }

  // Check if config is still enabled (may have been disabled since dispatch)
  if (!config.enabled && source === 'cron') {
    logger.info('[LIVEOPS-WORKER] Config disabled, skipping', { configId, configName });
    return;
  }

  // Atomic idempotency check + lock acquisition to prevent race conditions.
  // Cron jobs respect the idempotency window; manual jobs always allow.
  const lockAcquired =
    source === 'manual' ||
    (await liveopsTriageConfigRepository.atomicMarkRunStartedIfNotRecent(configId, IDEMPOTENCY_WINDOW_MS));

  if (!lockAcquired) {
    logger.warn('[LIVEOPS-WORKER] Another worker is already running or ran recently, skipping', {
      configId,
      configName,
      dispatchedAt: new Date(dispatchedAt).toISOString(),
    });
    return;
  }

  // Manual runs skip the atomic mark above, so mark started here instead.
  if (source === 'manual') {
    await liveopsTriageConfigRepository.markRunStarted(configId);
  }

  const run = await liveopsTriageRunRepository.createRun({
    configId: config.id,
    configName: config.name,
    runType: dryRun ? 'dry' : 'full',
    source,
  });
  await liveopsTriageRunRepository.markStarted(run.id);

  // Throttled progress updater
  let lastProgressUpdate = 0;
  const updateProgress = async (progress: number) => {
    const now = Date.now();
    if (now - lastProgressUpdate < PROGRESS_UPDATE_INTERVAL_MS) return;
    lastProgressUpdate = now;
    await liveopsTriageRunRepository.updateProgress(run.id, progress);
  };

  try {
    await updateProgress(5);

    const slackBotToken = await resolveSlackBotToken(config, logger);
    if (!slackBotToken) {
      throw new Error(
        config.organizationId
          ? 'No enabled Slack workspace with bot token found for organization'
          : 'No active Slack workspace with bot token found'
      );
    }

    await updateProgress(10);

    const issueTracker = createIssueTracker(config, logger);

    const healthCheck = await issueTracker.checkHealth();
    if (!healthCheck.healthy) {
      throw new Error(`Issue tracker unhealthy: ${healthCheck.error || 'Unknown error'}`);
    }

    await updateProgress(15);

    const service = createLiveopsTriageService(logger);

    // Manual runs can override lookback hours via the message; otherwise use config's interval
    const lookbackHours = messageLookbackHours ?? config.runIntervalHours;

    let errorsProcessed = 0;
    let issuesCreatedCount = 0;
    let issuesDeduplicated = 0;
    let status: 'success' | 'failed' = 'success';
    let fullDryRunResult: ILiveopsTriageDryRunResult | undefined;

    if (dryRun) {
      const dryRunResult = await service.runDryRunForConfig(slackBotToken, issueTracker, config, { lookbackHours });
      status = dryRunResult.status === 'success' ? 'success' : 'failed';
      errorsProcessed = dryRunResult.alertsToProcess;
      issuesCreatedCount = dryRunResult.issuesWouldCreate.length;
      issuesDeduplicated = dryRunResult.summary.duplicates;

      // Full dry run result for the UI modal; triageResults omitted to reduce storage size
      fullDryRunResult = {
        status: dryRunResult.status,
        lookbackHours: dryRunResult.lookbackHours,
        alertsFetched: dryRunResult.alertsFetched,
        alertsToProcess: dryRunResult.alertsToProcess,
        existingIssuesFound: dryRunResult.existingIssuesFound,
        summary: dryRunResult.summary,
        issuesWouldCreate: dryRunResult.issuesWouldCreate,
        issuesWouldSkip: dryRunResult.issuesWouldSkip,
        llmDetails: dryRunResult.llmDetails,
        error: dryRunResult.error,
      };
    } else {
      const triageResult = await service.runTriageForConfig(slackBotToken, issueTracker, config, { lookbackHours });
      status = triageResult.status === 'success' ? 'success' : 'failed';
      errorsProcessed = triageResult.errorsProcessed;
      issuesCreatedCount = triageResult.issuesCreated.length;
      issuesDeduplicated = triageResult.issuesDeduplicated;
    }

    await liveopsTriageRunRepository.markComplete(
      run.id,
      {
        errorsProcessed,
        issuesCreated: issuesCreatedCount,
        issuesDeduplicated,
      },
      fullDryRunResult
    );

    await liveopsTriageConfigRepository.markRunComplete(configId, {
      status: 'success',
      errorsProcessed,
      issuesCreated: issuesCreatedCount,
      issuesDeduplicated,
    });

    await liveopsTriageConfigRepository.resetConsecutiveFailures(configId);

    const duration = Date.now() - startTime;

    await Promise.all([
      emitMetric(
        CLOUDWATCH_NAMESPACE,
        'TriageRunSuccess',
        1,
        { Stage: stage, ConfigName: configName, IssueTracker: config.issueTracker },
        StandardUnit.Count
      ),
      emitMetric(
        CLOUDWATCH_NAMESPACE,
        'TriageDuration',
        duration,
        { Stage: stage, ConfigName: configName },
        StandardUnit.Milliseconds
      ),
      emitMetric(
        CLOUDWATCH_NAMESPACE,
        'ErrorsProcessed',
        errorsProcessed,
        { Stage: stage, ConfigName: configName },
        StandardUnit.Count
      ),
      emitMetric(
        CLOUDWATCH_NAMESPACE,
        'IssuesCreated',
        issuesCreatedCount,
        { Stage: stage, ConfigName: configName, IssueTracker: config.issueTracker },
        StandardUnit.Count
      ),
      emitMetric(
        CLOUDWATCH_NAMESPACE,
        'IssuesDeduplicated',
        issuesDeduplicated,
        { Stage: stage, ConfigName: configName },
        StandardUnit.Count
      ),
    ]);

    logger.info('[LIVEOPS-WORKER] Triage job completed successfully', {
      configId,
      configName,
      source,
      dryRun,
      status,
      errorsProcessed,
      issuesCreated: issuesCreatedCount,
      issuesDeduplicated,
      durationMs: duration,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const sanitizedError = sanitizeErrorMessage(errorMessage);

    await liveopsTriageRunRepository.markFailed(run.id, sanitizedError);

    await liveopsTriageConfigRepository.markRunComplete(configId, {
      status: 'failure',
      errorsProcessed: 0,
      issuesCreated: 0,
      issuesDeduplicated: 0,
      error: sanitizedError,
    });

    // Circuit breaker pattern: auto-disable after CIRCUIT_BREAKER_THRESHOLD consecutive failures
    const failures = await liveopsTriageConfigRepository.incrementConsecutiveFailures(configId);

    if (failures >= CIRCUIT_BREAKER_THRESHOLD) {
      logger.error('[LIVEOPS-WORKER] Circuit breaker tripped - disabling config', {
        configId,
        configName,
        consecutiveFailures: failures,
        threshold: CIRCUIT_BREAKER_THRESHOLD,
      });

      await liveopsTriageConfigRepository.updateConfig(configId, { enabled: false });

      await emitMetric(
        CLOUDWATCH_NAMESPACE,
        'CircuitBreakerTripped',
        1,
        { Stage: stage, ConfigName: configName, IssueTracker: config.issueTracker },
        StandardUnit.Count
      );
    }

    await emitMetric(
      CLOUDWATCH_NAMESPACE,
      'TriageRunFailure',
      1,
      { Stage: stage, ConfigName: configName, IssueTracker: config.issueTracker, ErrorType: 'RuntimeError' },
      StandardUnit.Count
    );

    logger.error('[LIVEOPS-WORKER] Triage job failed', {
      configId,
      configName,
      source,
      dryRun,
      error: sanitizedError,
      consecutiveFailures: failures,
    });

    // Re-throw to trigger DLQ after retries exhausted
    throw error;
  }
});

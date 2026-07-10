/**
 * LiveOps Triage Queue Handler
 *
 * Processes async manual triage runs (dry-run and actual runs).
 * Uses SQS to bypass CloudFront's 20-second timeout limit.
 */

import { SQSEvent, Context } from 'aws-lambda';
import { registerLambdaErrorHandlers } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { AdminSettings, slackDevWorkspaceRepository, liveOpsTriageJobRepository } from '@bike4mind/database';
import { LiveopsTriageConfigSchema } from '@bike4mind/common';
import { GitHubService } from '@server/services/githubService';
import { createLiveopsTriageService, sanitizeErrorMessage } from '@server/services/liveopsTriageService';
import { emitMetric } from '@server/utils/cloudwatch';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { dispatchWithLogger } from './utils';
import { z } from 'zod';
import { decryptToken } from '@server/security/tokenEncryption';

// Register global handlers to absorb transient network errors (TypeError: terminated)
// that escape try/catch via orphaned undici promises.
registerLambdaErrorHandlers();

const CLOUDWATCH_NAMESPACE = 'Lumina5/LiveOpsTriage';
const SETTING_NAME = 'liveopsTriageConfig';
const PROGRESS_UPDATE_INTERVAL_MS = 2000; // Throttle updates to every 2s

// Schema validation for SQS messages
const LiveOpsTriageMessageSchema = z.object({
  jobId: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid job ID format'),
  userId: z.string().min(1, 'User ID is required'),
  dryRun: z.boolean(),
  /** Optional lookback hours for "Run Now" - if not provided, uses config interval */
  lookbackHours: z.number().int().min(1).max(168).optional(),
});

type LiveOpsTriageMessage = z.infer<typeof LiveOpsTriageMessageSchema>;

/**
 * Get Slack bot token from configured workspace or fallback
 */
async function getSlackBotToken(logger: Logger): Promise<string | null> {
  const setting = await AdminSettings.findOne({ settingName: SETTING_NAME });
  const config = setting?.settingValue ? LiveopsTriageConfigSchema.parse(setting.settingValue) : { enabled: false };

  let slackBotToken: string | null = null;
  let usedFallback = false;

  if ('slackWorkspaceId' in config && config.slackWorkspaceId) {
    const workspace = await slackDevWorkspaceRepository.findByIdWithToken(config.slackWorkspaceId);
    if (workspace) {
      slackBotToken = decryptToken(workspace.slackBotToken) ?? null;
      logger.info('Using configured Slack workspace', { workspaceId: config.slackWorkspaceId });
    } else {
      logger.warn('Configured workspace not found, falling back to first active');
      usedFallback = true;
    }
  } else {
    usedFallback = true;
  }

  if (usedFallback) {
    const activeWorkspaces = await slackDevWorkspaceRepository.findAllActive();
    if (activeWorkspaces.length > 0 && activeWorkspaces[0].slackTeamId) {
      const workspaceWithToken = await slackDevWorkspaceRepository.findBySlackTeamIdWithToken(
        activeWorkspaces[0].slackTeamId
      );
      slackBotToken = decryptToken(workspaceWithToken?.slackBotToken) ?? null;
      if (slackBotToken) {
        logger.warn('No workspace configured, using first active workspace', {
          workspaceId: activeWorkspaces[0].id,
        });
      }
    }
  }

  return slackBotToken;
}

export const dispatch = dispatchWithLogger(async (event: SQSEvent, context: Context, logger: Logger) => {
  // Parse message from queue
  const record = event.Records[0];
  if (!record) {
    logger.error('No message in SQS event');
    return;
  }

  // Validate SQS message schema
  let message: LiveOpsTriageMessage;
  try {
    const parsed = JSON.parse(record.body);
    message = LiveOpsTriageMessageSchema.parse(parsed);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Invalid SQS message format', { error: errorMessage, body: record.body });
    // Don't retry malformed messages - they'll never succeed
    return;
  }

  const { jobId, dryRun, lookbackHours } = message;
  const startTime = Date.now();

  logger.info('Starting LiveOps Triage job', { jobId, dryRun, lookbackHours });

  // Idempotency check: Only process jobs that are still pending
  // This handles SQS message redelivery after Lambda timeout
  const existingJob = await liveOpsTriageJobRepository.findById(jobId);
  if (!existingJob) {
    logger.warn('Job not found, may have been deleted', { jobId });
    return;
  }

  if (existingJob.status !== 'pending') {
    logger.warn('Job already processed, skipping (idempotent)', {
      jobId,
      status: existingJob.status,
    });
    return;
  }

  // Mark job as started
  await liveOpsTriageJobRepository.markStarted(jobId);

  // Throttled progress updater
  let lastProgressUpdate = 0;
  const updateProgress = async (progress: number, step: string) => {
    const now = Date.now();
    if (now - lastProgressUpdate < PROGRESS_UPDATE_INTERVAL_MS) return;
    lastProgressUpdate = now;
    await liveOpsTriageJobRepository.updateProgress(jobId, progress, step);
  };

  try {
    await updateProgress(5, 'Connecting to services...');

    // Get Slack bot token. getSlackBotToken() returns null only for permanent config
    // states (no workspace configured / no active workspace / workspace has no bot
    // token stored) - swallow those here (log, markFailed, return) so SQS doesn't
    // retry a message that can never succeed. A genuine decrypt failure (bad
    // SECRET_ENCRYPTION_KEY, corrupted token) throws from decryptToken() itself and
    // falls through to the outer catch for SQS retry.
    const slackBotToken = await getSlackBotToken(logger);
    if (!slackBotToken) {
      logger.warn('No active Slack workspace with bot token found - failing job without retry', { jobId });
      await liveOpsTriageJobRepository.markFailed(jobId, {
        errorMessage: 'No active Slack workspace with bot token found',
      });
      await emitMetric(
        CLOUDWATCH_NAMESPACE,
        'ManualRunFailure',
        1,
        { DryRun: String(dryRun), ErrorType: 'NoSlackWorkspace' },
        StandardUnit.Count
      );
      return;
    }

    await updateProgress(10, 'Connecting to GitHub...');

    // Get GitHub service. forSystem() returns null only for permanent config states
    // (no connection / disabled / suspended) - swallow those here (log, markFailed,
    // return) so SQS doesn't retry a message that can never succeed. It already logged
    // the specific reason. Transient failures (DB error, auth init) throw from
    // forSystem() itself and fall through to the outer catch for SQS retry.
    const githubService = await GitHubService.forSystem(logger);
    if (!githubService) {
      logger.warn('No system GitHub connection configured - failing job without retry', { jobId });
      await liveOpsTriageJobRepository.markFailed(jobId, {
        errorMessage: 'No system GitHub connection configured',
      });
      await emitMetric(
        CLOUDWATCH_NAMESPACE,
        'ManualRunFailure',
        1,
        { DryRun: String(dryRun), ErrorType: 'NoGitHubConnection' },
        StandardUnit.Count
      );
      return;
    }

    await updateProgress(15, 'Fetching alerts from Slack...');

    // Create service and run triage
    const service = createLiveopsTriageService(logger);

    // Run dry run or actual triage
    const result = dryRun
      ? await service.runDryRun(slackBotToken, githubService, { lookbackHours })
      : await service.runTriage(slackBotToken, githubService, { bypassEnabledCheck: true, lookbackHours });

    // Mark job as complete - cast to ILiveOpsTriageJobResult since the result types are compatible
    // The schema uses Mixed type so any shape is accepted
    await liveOpsTriageJobRepository.markComplete(
      jobId,
      result as unknown as Parameters<typeof liveOpsTriageJobRepository.markComplete>[1]
    );

    // Emit success metrics
    const duration = Date.now() - startTime;
    await Promise.all([
      emitMetric(CLOUDWATCH_NAMESPACE, 'ManualRunSuccess', 1, { DryRun: String(dryRun) }, StandardUnit.Count),
      emitMetric(
        CLOUDWATCH_NAMESPACE,
        'ManualRunDuration',
        duration,
        { DryRun: String(dryRun) },
        StandardUnit.Milliseconds
      ),
    ]);

    // Type-safe logging with explicit type narrowing
    if (dryRun) {
      const dryRunResult = result as { alertsFetched?: number; issuesWouldCreate?: unknown[] };
      logger.info('LiveOps Triage job completed', {
        jobId,
        dryRun,
        status: result.status,
        durationMs: duration,
        alertsFetched: dryRunResult.alertsFetched,
        issuesWouldCreate: dryRunResult.issuesWouldCreate?.length ?? 0,
      });
    } else {
      const triageResult = result as { errorsProcessed?: number; issuesCreated?: unknown[] };
      logger.info('LiveOps Triage job completed', {
        jobId,
        dryRun,
        status: result.status,
        durationMs: duration,
        errorsProcessed: triageResult.errorsProcessed,
        issuesCreated: triageResult.issuesCreated?.length ?? 0,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const sanitizedError = sanitizeErrorMessage(errorMessage);

    // Mark job as failed
    await liveOpsTriageJobRepository.markFailed(jobId, { errorMessage: sanitizedError });

    // Emit failure metric
    await emitMetric(CLOUDWATCH_NAMESPACE, 'ManualRunFailure', 1, { DryRun: String(dryRun) }, StandardUnit.Count);

    logger.error('LiveOps Triage job failed', { jobId, dryRun, error: sanitizedError });

    // Re-throw to trigger DLQ after retries exhausted
    throw error;
  }
});

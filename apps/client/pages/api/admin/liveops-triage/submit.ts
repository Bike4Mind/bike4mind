/**
 * LiveOps Triage Submit API
 *
 * Queues a background job for manual triage runs (dry-run or actual).
 * Returns immediately with a job ID for status polling.
 *
 * POST /api/admin/liveops-triage/submit
 * Body: { dryRun: boolean }
 */

import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';
import { liveOpsTriageJobRepository } from '@bike4mind/database';
import { sendToQueue } from '@server/utils/sqs';
import { Resource } from 'sst';

const ONE_MINUTE_MS = 60 * 1000;

const SubmitRequestSchema = z.object({
  dryRun: z.boolean().default(false),
  /** Optional lookback hours for "Run Now" - if not provided, uses config interval */
  lookbackHours: z.number().int().min(1).max(168).optional(), // 1 hour to 7 days
});

// Type assertion for SST Resource - the liveOpsTriageQueue is linked in infra/web.ts
// but types are auto-generated on deployment, so we need to tell TypeScript about it
const liveOpsTriageQueue = (Resource as unknown as { liveOpsTriageQueue: { url: string } }).liveOpsTriageQueue;

const handler = baseApi()
  .use(rateLimit({ limit: 5, windowMs: ONE_MINUTE_MS }))
  .post(async (req, res) => {
    // Check admin access
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const userId = req.user.id;
    const logger = new Logger({ metadata: { service: 'LiveOpsTriageSubmit', userId } });

    // Validate request body
    const result = SubmitRequestSchema.safeParse(req.body);
    if (!result.success) {
      throw new BadRequestError(result.error.issues[0]?.message || 'Invalid request body');
    }

    const { dryRun, lookbackHours } = result.data;
    const runType = dryRun ? 'dry run' : 'manual run';

    logger.info(`Starting LiveOps Triage ${runType} submission`, { dryRun, lookbackHours });

    // Runtime validation for SST Resource
    if (!liveOpsTriageQueue?.url) {
      logger.error('liveOpsTriageQueue not available - SST resource may not be linked');
      return res.status(500).json({
        success: false,
        error: 'LiveOps Triage queue not configured. Contact administrator.',
      });
    }

    // Atomic mutex: Create job only if no active job exists
    // This prevents race conditions between check and create
    const createResult = await liveOpsTriageJobRepository.createIfNoActiveJob({
      userId,
      dryRun,
      status: 'pending',
      progress: 0,
      currentStep: 'Queued for processing...',
    });

    if (!createResult.created) {
      logger.info('Triage run already in progress', {
        activeJobId: createResult.activeJob.id,
        status: createResult.activeJob.status,
      });

      return res.status(409).json({
        success: false,
        error: 'A triage run is already in progress',
        activeJobId: createResult.activeJob.id,
        status: createResult.activeJob.status,
        startedAt: createResult.activeJob.startedAt,
      });
    }

    const job = createResult.job;

    logger.info('LiveOps Triage job created', { jobId: job.id, dryRun });

    // Send message to SQS queue - mark job failed if this fails
    try {
      await sendToQueue(liveOpsTriageQueue.url, {
        jobId: job.id,
        userId,
        dryRun,
        lookbackHours, // Will be undefined if not provided (uses config interval)
      });

      logger.info('LiveOps Triage job queued', { jobId: job.id });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Mark job as failed since we couldn't queue it
      await liveOpsTriageJobRepository.markFailed(job.id, {
        errorMessage: `Failed to queue job: ${errorMessage}`,
      });

      logger.error('Failed to queue LiveOps Triage job', { jobId: job.id, error: errorMessage });

      throw new BadRequestError('Failed to start triage. Please try again.');
    }

    return res.json({
      success: true,
      jobId: job.id,
      status: 'pending',
      message: dryRun ? 'Dry run queued successfully' : 'Manual run queued successfully',
    });
  });

export default handler;

// Next.js config must be a static object literal
export const config = {
  api: {
    externalResolver: true,
  },
};

/**
 * LiveOps Triage Status API
 *
 * GET /api/admin/liveops-triage/status/[jobId] - Get job status
 */

import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { ForbiddenError, BadRequestError, NotFoundError } from '@server/utils/errors';
import { liveOpsTriageJobRepository } from '@bike4mind/database';
import { z } from 'zod';

const ONE_MINUTE_MS = 60 * 1000;

// Validate MongoDB ObjectId format
const JobIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid job ID format');

const handler = baseApi()
  .use(rateLimit({ limit: 30, windowMs: ONE_MINUTE_MS })) // 30 requests/min for polling
  .get(async (req, res) => {
    // Check admin access
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { jobId } = req.query;
    if (!jobId || typeof jobId !== 'string') {
      throw new BadRequestError('Job ID is required');
    }

    // Validate jobId format
    const parseResult = JobIdSchema.safeParse(jobId);
    if (!parseResult.success) {
      throw new BadRequestError('Invalid job ID format');
    }

    const job = await liveOpsTriageJobRepository.findById(jobId);
    if (!job) {
      throw new NotFoundError('Job not found');
    }

    // Verify job ownership - admins can only view their own jobs
    if (job.userId !== req.user.id) {
      throw new ForbiddenError('Cannot access job from another user');
    }

    return res.json({
      success: true,
      job: {
        id: job.id,
        dryRun: job.dryRun,
        status: job.status,
        progress: job.progress,
        currentStep: job.currentStep,
        // Results (only for completed jobs)
        result: job.status === 'completed' ? job.result : undefined,
        // Error info (only for failed jobs)
        errorMessage: job.status === 'failed' ? job.errorMessage : undefined,
        // Timing
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
      },
    });
  });

export default handler;

// Next.js config must be a static object literal
export const config = {
  api: {
    externalResolver: true,
  },
};

import { emailJobRepository, emailSendAttemptRepository } from '@bike4mind/database';
import { ApiKeyScope, EmailSendStatus } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { reconcileEmailJob } from '@bike4mind/server-utils/email/reconcileEmailJob';

// Timeout threshold in minutes - emails stuck in pending/processing longer than this are considered timed out
const TIMEOUT_THRESHOLD_MINUTES = 30;

/**
 * POST /api/admin/email/jobs/:id/check-status
 *
 * Check for timed-out emails and update job status.
 * - Marks emails stuck in pending/processing as failed
 * - Recounts the job's totals and completes it once nothing is in flight
 */
const handler = adminApi({
  adminPermissions: { POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).post(async (req, res) => {
  const { id } = req.query as { id: string };

  const job = await emailJobRepository.findById(id);
  if (!job) {
    throw new NotFoundError('Job not found');
  }

  const timeoutThreshold = new Date();
  timeoutThreshold.setMinutes(timeoutThreshold.getMinutes() - TIMEOUT_THRESHOLD_MINUTES);

  const EmailSendAttempt = (await import('@bike4mind/database')).EmailSendAttempt;

  const timedOutResult = await EmailSendAttempt.updateMany(
    {
      jobId: id,
      status: { $in: [EmailSendStatus.PENDING, EmailSendStatus.PROCESSING] },
      createdAt: { $lt: timeoutThreshold },
    },
    {
      $set: {
        status: EmailSendStatus.FAILED,
        errorMessage: `Timed out after ${TIMEOUT_THRESHOLD_MINUTES} minutes`,
      },
    }
  );

  const timedOutCount = timedOutResult.modifiedCount;

  // The recount is the one writer of counts and completion, so a concurrent batch or worker
  // outcome cannot be overwritten by a stale read here.
  await reconcileEmailJob(id);

  const [summary, updated] = await Promise.all([
    emailSendAttemptRepository.getJobSummary(id),
    emailJobRepository.findById(id),
  ]);
  const newOverallStatus = updated?.overallStatus ?? job.overallStatus;

  return res.json({
    success: true,
    timedOutCount,
    timeoutThresholdMinutes: TIMEOUT_THRESHOLD_MINUTES,
    summary: {
      ...summary,
      overallStatus: newOverallStatus,
    },
    statusChanged: newOverallStatus !== job.overallStatus,
    previousStatus: job.overallStatus,
    newStatus: newOverallStatus,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

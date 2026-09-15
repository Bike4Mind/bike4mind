import { emailJobRepository, emailSendAttemptRepository } from '@bike4mind/database';
import { EmailSendStatus, EmailJobOverallStatus } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';

// Timeout threshold in minutes - emails stuck in pending/processing longer than this are considered timed out
const TIMEOUT_THRESHOLD_MINUTES = 30;

/**
 * POST /api/admin/email/jobs/:id/check-status
 *
 * Check for timed-out emails and update job status.
 * - Marks emails stuck in pending/processing as failed
 * - Updates job overall status based on current state
 */
const handler = baseApi().post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

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

  const summary = await emailSendAttemptRepository.getJobSummary(id);

  // Determine new job status based on attempts
  let newOverallStatus = job.overallStatus;

  // If there are still pending/processing emails, job is still sending
  if (summary.pending > 0 || summary.processing > 0) {
    newOverallStatus = EmailJobOverallStatus.SENDING;
  } else if (summary.total === 0) {
    // No attempts yet
    newOverallStatus = EmailJobOverallStatus.DRAFT;
  } else if (summary.failed > 0 && summary.sent === 0) {
    // All failed
    newOverallStatus = EmailJobOverallStatus.FAILED;
  } else if (summary.failed > 0 && summary.sent > 0) {
    // Some succeeded, some failed
    newOverallStatus = EmailJobOverallStatus.PARTIAL;
  } else if (summary.sent > 0) {
    // All succeeded
    newOverallStatus = EmailJobOverallStatus.COMPLETE;
  }

  // Update job status if changed
  if (newOverallStatus !== job.overallStatus) {
    await emailJobRepository.update({
      id,
      overallStatus: newOverallStatus,
      failedCount: job.failedCount + timedOutCount,
    });
  } else if (timedOutCount > 0) {
    // Just update failed count
    await emailJobRepository.update({
      id,
      failedCount: job.failedCount + timedOutCount,
    });
  }

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

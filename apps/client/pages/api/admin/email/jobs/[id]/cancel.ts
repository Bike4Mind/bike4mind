import { emailJobRepository, emailSendAttemptRepository } from '@bike4mind/database';
import { EmailJobStatus, EmailJobOverallStatus } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';

const handler = baseApi().post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const { id } = req.query as { id: string };
  const { recipientIds } = req.body as { recipientIds?: string[] };

  const job = await emailJobRepository.findById(id);
  if (!job) {
    throw new NotFoundError('Job not found');
  }

  // Can cancel while actively sending (to stop pending emails), or when scheduled/queued/processing.
  const canCancel =
    job.overallStatus === EmailJobOverallStatus.SENDING ||
    job.status === EmailJobStatus.SCHEDULED ||
    job.status === EmailJobStatus.QUEUED ||
    job.status === EmailJobStatus.PROCESSING;

  if (!canCancel) {
    throw new BadRequestError('Cannot cancel this campaign. It is not currently sending or scheduled.');
  }

  const cancelledCount = await emailSendAttemptRepository.cancelPendingAttempts(id, recipientIds);

  // Cancelling all pending marks the job CANCELLED/PARTIAL; cancelling specific recipients leaves status unchanged.
  if (!recipientIds) {
    await emailJobRepository.update({
      id,
      status: EmailJobStatus.CANCELLED,
      overallStatus: EmailJobOverallStatus.PARTIAL,
      cancelledCount: (job.cancelledCount || 0) + cancelledCount,
    });
  } else {
    // Just update the cancelled count
    await emailJobRepository.update({
      id,
      cancelledCount: (job.cancelledCount || 0) + cancelledCount,
    });
  }

  return res.json({
    success: true,
    message: `Cancelled ${cancelledCount} pending email(s)`,
    cancelledCount,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

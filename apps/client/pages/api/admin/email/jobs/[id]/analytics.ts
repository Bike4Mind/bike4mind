import { emailJobRepository, emailSendAttemptRepository } from '@bike4mind/database';
import { EmailSendStatus } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';

const handler = baseApi().get(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const {
    id,
    page = '1',
    limit = '50',
    status,
    search,
    excludeTest,
    startDate,
    endDate,
  } = req.query as {
    id: string;
    page?: string;
    limit?: string;
    status?: EmailSendStatus;
    search?: string;
    excludeTest?: string;
    startDate?: string;
    endDate?: string;
  };

  const job = await emailJobRepository.findById(id);
  if (!job) {
    throw new NotFoundError('Job not found');
  }

  const attempts = await emailSendAttemptRepository.findByJob(id, {
    page: parseInt(page, 10),
    limit: parseInt(limit, 10),
    status,
    search,
    excludeTest: excludeTest === 'true',
    startDate: startDate ? new Date(startDate) : undefined,
    endDate: endDate ? new Date(endDate) : undefined,
  });

  const openRate = job.sentCount > 0 ? ((job.openedCount / job.sentCount) * 100).toFixed(2) : '0.00';
  const clickRate = job.sentCount > 0 ? ((job.clickedCount / job.sentCount) * 100).toFixed(2) : '0.00';
  const failureRate = job.recipientCount > 0 ? ((job.failedCount / job.recipientCount) * 100).toFixed(2) : '0.00';

  return res.json({
    job: {
      id: job.id,
      name: job.name,
      status: job.status,
      recipientCount: job.recipientCount,
      sentCount: job.sentCount,
      failedCount: job.failedCount,
      openedCount: job.openedCount,
      clickedCount: job.clickedCount,
      openRate: `${openRate}%`,
      clickRate: `${clickRate}%`,
      failureRate: `${failureRate}%`,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    },
    attempts,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

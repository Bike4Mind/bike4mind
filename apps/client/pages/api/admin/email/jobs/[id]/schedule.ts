import { emailJobRepository } from '@bike4mind/database';
import { EmailJobStatus } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';

const handler = baseApi().post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const { id } = req.query as { id: string };
  const { scheduledAt } = req.body as { scheduledAt: string };

  if (!scheduledAt) {
    throw new BadRequestError('scheduledAt is required');
  }

  const scheduledDate = new Date(scheduledAt);
  if (isNaN(scheduledDate.getTime())) {
    throw new BadRequestError('Invalid scheduledAt date');
  }

  if (scheduledDate <= new Date()) {
    throw new BadRequestError('scheduledAt must be in the future');
  }

  const job = await emailJobRepository.findById(id);
  if (!job) {
    throw new NotFoundError('Job not found');
  }

  if (job.status !== EmailJobStatus.DRAFT) {
    throw new BadRequestError('Can only schedule jobs in draft status');
  }

  // Update status to scheduled
  const updated = await emailJobRepository.update({
    id,
    status: EmailJobStatus.SCHEDULED,
    scheduledAt: scheduledDate,
  });

  return res.json(updated);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

import { emailJobRepository } from '@bike4mind/database';
import { ApiKeyScope, EmailJobStatus } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

const handler = adminApi({
  adminPermissions: { POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).post(async (req, res) => {
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

  await recordAdminActionFromRequest(req, {
    action: 'email.job.scheduled',
    target: { kind: 'settings', id, displayName: job.name },
    summary: `scheduled email job ${job.name}`,
    details: { scheduledAt: scheduledDate.toISOString() },
  });

  return res.json(updated);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

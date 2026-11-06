import { emailJobRepository, withTransaction } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { sendToQueue } from '@bike4mind/server-utils/utils/sqs';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

const handler = adminApi({
  adminPermissions: { POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).post(async (req, res) => {
  const { id } = req.query as { id: string };

  const actingUserId = req.user.id;

  // Strict audit shares the claim transaction and runs before the enqueue, so a failed audit sends nothing.
  const job = await withTransaction(async () => {
    const claimed = await emailJobRepository.claimForStart(id, { startedBy: actingUserId });
    if (!claimed) return null;

    await recordAdminActionFromRequest(req, {
      action: 'email.job.started',
      target: { kind: 'settings', id, displayName: claimed.name },
      summary: `started email job ${claimed.name}`,
      details: { templateId: claimed.templateId },
    });

    return claimed;
  });
  if (!job) {
    const existingJob = await emailJobRepository.findById(id);
    if (!existingJob) {
      throw new NotFoundError('Job not found');
    }
    throw new BadRequestError('Job has already been started');
  }

  // Send to job queue
  await sendToQueue(getSourceQueueUrl('emailJobQueue'), {
    jobId: id,
  });

  return res.json({ success: true, message: 'Job queued for processing' });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

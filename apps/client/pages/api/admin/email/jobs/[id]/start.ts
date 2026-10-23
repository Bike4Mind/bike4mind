import { emailJobRepository, withTransaction } from '@bike4mind/database';
import { ApiKeyScope, EmailJobStatus } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { sendToQueue } from '@bike4mind/server-utils/utils/sqs';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const { id } = req.query as { id: string };

  const job = await emailJobRepository.findById(id);
  if (!job) {
    throw new NotFoundError('Job not found');
  }

  if (job.status !== EmailJobStatus.DRAFT) {
    throw new BadRequestError('Job has already been started');
  }

  // Strict audit shares the status transaction and runs before the enqueue, so a failed audit sends nothing.
  await withTransaction(async () => {
    await emailJobRepository.update({
      id,
      status: EmailJobStatus.QUEUED,
      startedBy: req.user!.id,
    });

    await recordAdminActionFromRequest(req, {
      action: job.isTestMode ? 'email.job.test_started' : 'email.job.started',
      target: { kind: 'settings', id, displayName: job.name },
      summary: `started email job ${job.name}`,
      details: { templateId: job.templateId, isTestMode: job.isTestMode },
    });
  });

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

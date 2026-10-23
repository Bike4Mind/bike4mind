import { emailJobRepository, withTransaction } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
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

  const actingUserId = req.user.id;

  // Strict audit shares the claim transaction and runs before the enqueue, so a failed audit sends nothing.
  const job = await withTransaction(async () => {
    const claimed = await emailJobRepository.claimForStart(id, { startedBy: actingUserId });
    if (!claimed) return null;

    await recordAdminActionFromRequest(req, {
      action: claimed.isTestMode ? 'email.job.test_started' : 'email.job.started',
      target: { kind: 'settings', id, displayName: claimed.name },
      summary: `${claimed.isTestMode ? 'started test of' : 'started'} email job ${claimed.name}`,
      details: { templateId: claimed.templateId, isTestMode: claimed.isTestMode },
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

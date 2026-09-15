import { emailJobRepository } from '@bike4mind/database';
import { EmailJobStatus } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { sendToQueue } from '@server/utils/sqs';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';

const handler = baseApi().post(async (req, res) => {
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

  // Update status to queued and record who started it
  await emailJobRepository.update({
    id,
    status: EmailJobStatus.QUEUED,
    startedBy: req.user.id,
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

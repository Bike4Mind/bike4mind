import { emailJobRepository } from '@bike4mind/database';
import { EmailJobStatus, EmailJobOverallStatus } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';

/**
 * Clone an existing email job to create a new draft
 * This allows reusing completed/cancelled campaigns
 */
const handler = baseApi().post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const { id } = req.query as { id: string };

  const existing = await emailJobRepository.findById(id);
  if (!existing) {
    throw new NotFoundError('Job not found');
  }

  const cloned = await emailJobRepository.create({
    name: `${existing.name} (Copy)`,
    templateId: existing.templateId,
    subject: existing.subject,
    variables: existing.variables,
    category: existing.category,
    status: EmailJobStatus.DRAFT,
    overallStatus: EmailJobOverallStatus.DRAFT,
    recipientFilter: existing.recipientFilter,
    recipientCount: 0,
    isTestMode: existing.isTestMode || false,
    testEmailAddresses: existing.testEmailAddresses || [],
    sentCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    openedCount: 0,
    clickedCount: 0,
    totalEmailsSent: 0,
    createdBy: req.user.id,
  });

  return res.status(201).json(cloned);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

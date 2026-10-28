import { emailJobRepository } from '@bike4mind/database';
import { ApiKeyScope, EmailJobOverallStatus, EmailJobStatus } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

/**
 * Clone an existing email job to create a new draft
 * This allows reusing completed/cancelled campaigns
 */
const handler = adminApi({
  adminPermissions: { POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).post(async (req, res) => {
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

  await recordAdminActionFromRequest(req, {
    action: 'email.job.cloned',
    target: { kind: 'settings', id: cloned.id, displayName: cloned.name },
    summary: `cloned email job ${existing.name}`,
    details: { sourceJobId: id },
  });

  return res.status(201).json(cloned);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

import { emailJobRepository, emailTemplateRepository } from '@bike4mind/database';
import { ApiKeyScope, EmailJobOverallStatus, EmailJobStatus } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { z } from 'zod';
import { assertParseableDate } from '@server/utils/dateParam';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

const RecipientFilterSchema = z
  .object({
    all: z.boolean().optional(),
    allUsers: z.boolean().optional(),
    allSubscribers: z.boolean().optional(),
    userIds: z.array(z.string()).optional(),
    subscriberIds: z.array(z.string()).optional(),
    specificEmails: z.array(z.email()).optional(),
    tags: z.array(z.string()).optional(),
  })
  .optional();

const handler = adminApi({
  adminPermissions: { GET: 'support:read', POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .get(async (req, res) => {
    const {
      page = '1',
      limit = '20',
      status,
      excludeTest,
      startDate,
      endDate,
    } = req.query as {
      page?: string;
      limit?: string;
      status?: EmailJobStatus;
      excludeTest?: string;
      startDate?: string;
      endDate?: string;
    };

    assertParseableDate('startDate', startDate);
    assertParseableDate('endDate', endDate);

    const result = await emailJobRepository.listJobs({
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      status,
      excludeTest: excludeTest === 'true',
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    });

    return res.json(result);
  })
  .post(async (req, res) => {
    const { name, templateId, subject, variables = {}, isTestMode, testEmailAddresses } = req.body;

    // Validate recipientFilter with Zod schema
    const recipientFilterResult = RecipientFilterSchema.safeParse(req.body.recipientFilter);
    if (!recipientFilterResult.success) {
      throw new BadRequestError(`Invalid recipientFilter: ${recipientFilterResult.error.message}`);
    }
    const recipientFilter = recipientFilterResult.data;

    if (!name || !templateId) {
      throw new BadRequestError('Name and templateId are required');
    }

    // Validate template exists
    const template = await emailTemplateRepository.findById(templateId);
    if (!template) {
      throw new NotFoundError('Template not found');
    }

    const job = await emailJobRepository.create({
      name,
      templateId,
      subject,
      variables,
      category: template.category,
      status: EmailJobStatus.DRAFT,
      overallStatus: EmailJobOverallStatus.DRAFT,
      recipientFilter,
      recipientCount: 0,
      isTestMode: isTestMode || false,
      testEmailAddresses: testEmailAddresses || [],
      sentCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      openedCount: 0,
      clickedCount: 0,
      totalEmailsSent: 0,
      createdBy: req.user.id,
    });

    await recordAdminActionFromRequest(req, {
      action: 'email.job.created',
      target: { kind: 'settings', id: job.id, displayName: job.name },
      summary: `created email job ${job.name}`,
      details: { templateId, isTestMode: Boolean(job.isTestMode) },
    });

    return res.status(201).json(job);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

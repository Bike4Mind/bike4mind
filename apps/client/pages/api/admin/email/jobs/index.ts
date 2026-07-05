import { emailJobRepository, emailTemplateRepository } from '@bike4mind/database';
import { EmailJobStatus, EmailJobOverallStatus } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { z } from 'zod';

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

const handler = baseApi()
  .get(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

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
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

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

    return res.status(201).json(job);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

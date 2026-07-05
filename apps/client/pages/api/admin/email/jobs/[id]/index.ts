import { emailJobRepository } from '@bike4mind/database';
import { EmailJobOverallStatus } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';

const handler = baseApi()
  .get(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as { id: string };

    const job = await emailJobRepository.findById(id);
    if (!job) {
      throw new NotFoundError('Job not found');
    }

    return res.json(job);
  })
  .put(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as { id: string };

    const existing = await emailJobRepository.findById(id);
    if (!existing) {
      throw new NotFoundError('Job not found');
    }

    // Only block updates while actively sending (reusable campaigns can be edited anytime otherwise)
    if (existing.overallStatus === EmailJobOverallStatus.SENDING) {
      throw new BadRequestError('Cannot update campaign while sending is in progress');
    }

    const { name, subject, variables, recipientFilter, isTestMode, testEmailAddresses } = req.body as {
      name?: string;
      subject?: string;
      variables?: Record<string, string>;
      recipientFilter?: {
        all?: boolean;
        allUsers?: boolean;
        allSubscribers?: boolean;
        userIds?: string[];
        subscriberIds?: string[];
        specificEmails?: string[];
        tags?: string[];
      };
      isTestMode?: boolean;
      testEmailAddresses?: string[];
    };

    const updated = await emailJobRepository.update({
      id,
      ...(name !== undefined && { name }),
      ...(subject !== undefined && { subject }),
      ...(variables !== undefined && { variables }),
      ...(recipientFilter !== undefined && { recipientFilter }),
      ...(isTestMode !== undefined && { isTestMode }),
      ...(testEmailAddresses !== undefined && { testEmailAddresses }),
    });

    return res.json(updated);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

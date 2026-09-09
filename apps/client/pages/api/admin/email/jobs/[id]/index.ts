import { emailJobRepository } from '@bike4mind/database';
import { EmailJobOverallStatus } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { z } from 'zod';

// Reaches `BaseRepository.update` -> `$set`, so these cast before validators run. `isTestMode`
// and the `recipientFilter` booleans are Boolean-typed (throw `CastError kind='Boolean'` on 2,
// {} or []), and `testEmailAddresses` plus the filter's four id arrays are `[String]` (throw on
// an object element). `variables` is a `Map<String>`: a non-object there raises a TypeError
// rather than a CastError, so it answers 500 both before and after the narrowing -- validating
// it here is an improvement, not a regression fix, and is included because it is the same body.
const recipientFilterSchema = z.object({
  all: z.boolean().optional(),
  allUsers: z.boolean().optional(),
  allSubscribers: z.boolean().optional(),
  userIds: z.array(z.string()).optional(),
  subscriberIds: z.array(z.string()).optional(),
  specificEmails: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});

const updateBodySchema = z.object({
  name: z.string().optional(),
  subject: z.string().optional(),
  variables: z.record(z.string(), z.string()).optional(),
  recipientFilter: recipientFilterSchema.optional(),
  isTestMode: z.boolean().optional(),
  testEmailAddresses: z.array(z.string()).optional(),
});

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

    const parsedBody = updateBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new BadRequestError('Invalid request body');
    }
    const { name, subject, variables, recipientFilter, isTestMode, testEmailAddresses } = parsedBody.data;

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

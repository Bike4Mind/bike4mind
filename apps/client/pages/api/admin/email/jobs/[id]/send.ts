import { emailJobRepository } from '@bike4mind/database';
import { EmailJobOverallStatus } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { sendToQueue } from '@server/utils/sqs';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { z } from 'zod';

const RecipientFilterSchema = z
  .object({
    all: z.boolean().optional(),
    allUsers: z.boolean().optional(),
    allSubscribers: z.boolean().optional(),
    userIds: z.array(z.string()).optional(),
    subscriberIds: z.array(z.string()).optional(),
    specificEmails: z.array(z.email()).optional(),
  })
  .optional();

/**
 * POST /api/admin/email/jobs/:id/send
 *
 * Send emails for a campaign. Can be called multiple times (reusable campaigns).
 * Unlike /start, this endpoint:
 * - Allows sending even if job has been sent before
 * - Supports partial sends (specific users only)
 * - Supports test mode (redirect to test recipients)
 */
const handler = baseApi().post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const { id } = req.query as { id: string };
  const { userIds, testMode, testRecipients, testSubjectIndicator } = req.body;

  // Validate recipientFilter with Zod schema
  const recipientFilterResult = RecipientFilterSchema.safeParse(req.body.recipientFilter);
  if (!recipientFilterResult.success) {
    throw new BadRequestError(`Invalid recipientFilter: ${recipientFilterResult.error.message}`);
  }
  const recipientFilter = recipientFilterResult.data;

  // Atomically claim the job for sending (prevents duplicate sends from concurrent requests)
  const job = await emailJobRepository.claimForSending(id, {
    lastSentAt: new Date(),
    lastSentBy: req.user.id,
    startedBy: req.user.id,
  });
  if (!job) {
    // Either job doesn't exist or is already sending
    const existingJob = await emailJobRepository.findById(id);
    if (!existingJob) {
      throw new NotFoundError('Job not found');
    }
    throw new BadRequestError('Job is currently being sent. Please wait for it to complete or cancel it first.');
  }

  // If in test mode, require at least one test recipient
  if (testMode) {
    const allTestRecipients = [...(testRecipients || []), ...(job.testEmailAddresses || [])];
    if (allTestRecipients.length === 0) {
      // Roll back the status since we're not actually sending
      await emailJobRepository.updateOverallStatus(id, EmailJobOverallStatus.DRAFT);
      throw new BadRequestError('Test mode requires at least one test recipient email address.');
    }
  }

  // Queue the job for processing
  // The orchestrator will handle the actual sending
  await sendToQueue(getSourceQueueUrl('emailJobQueue'), {
    jobId: id,
    // Send options
    userIds,
    testMode: testMode || false,
    testRecipients: testRecipients || [],
    testSubjectIndicator: testSubjectIndicator !== false, // Default to true
    triggeredBy: req.user.name || req.user.email,
    // Pass recipient filter from form to ensure we use current state, not stale job data
    recipientFilter: recipientFilter || undefined,
  });

  return res.json({
    success: true,
    message: 'Job queued for sending',
    jobId: id,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

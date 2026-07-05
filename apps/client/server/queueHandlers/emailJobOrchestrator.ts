import {
  emailJobRepository,
  emailSendAttemptRepository,
  emailTemplateRepository,
  emailPreferencesRepository,
  userRepository,
  subscriberRepository,
} from '@bike4mind/database';
import { EmailJobStatus, EmailJobOverallStatus, EmailSendStatus } from '@bike4mind/common';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { Resource } from 'sst';
import { z } from 'zod';
import { randomUUID } from 'crypto';

const RecipientFilterSchema = z.object({
  allUsers: z.boolean().optional(),
  allSubscribers: z.boolean().optional(),
  userIds: z.array(z.string()).optional(),
  subscriberIds: z.array(z.string()).optional(),
  specificEmails: z.array(z.string()).optional(),
  all: z.boolean().optional(),
});

const JobStartPayload = z.object({
  jobId: z.string(),
  // Reusable campaign options
  userIds: z.array(z.string()).optional(),
  testMode: z.boolean().optional(),
  testRecipients: z.array(z.string()).optional(),
  testSubjectIndicator: z.boolean().optional(),
  triggeredBy: z.string().optional(),
  // Recipient filter override (uses current form state instead of stale job data)
  recipientFilter: RecipientFilterSchema.optional(),
});

// Batch sizes for scalable processing
const EMAILS_PER_BATCH = 25; // Number of emails per SQS message/batch
const SQS_BATCH_SIZE = 10; // Max SQS messages per SendMessageBatch call (AWS limit)

interface Recipient {
  id: string;
  type: 'user' | 'subscriber' | 'direct';
  email: string;
  originalRecipient?: string;
  isTestEmail?: boolean;
}

interface SendAttemptOptions {
  isTestEmail: boolean;
  testSubjectIndicator: boolean;
  sentBy?: string;
}

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const body = JSON.parse(event.Records[0].body);
  const payload = JobStartPayload.parse(body);
  const {
    jobId,
    userIds,
    testMode,
    testRecipients,
    testSubjectIndicator,
    triggeredBy,
    recipientFilter: payloadRecipientFilter,
  } = payload;

  logger.updateMetadata({ jobId, testMode: testMode || false });
  logger.info('Starting email job orchestration');

  // 1. Get job and validate
  const job = await emailJobRepository.findById(jobId);
  if (!job) {
    logger.error('Job not found');
    return;
  }

  // Note: We don't check if already SENDING here because the /send API endpoint
  // sets the status to SENDING before queuing the message. The API endpoint
  // already prevents concurrent sends by checking overallStatus before allowing a new send.

  // 2. Get template
  const template = await emailTemplateRepository.findById(job.templateId);
  if (!template) {
    logger.error('Template not found');
    await emailJobRepository.update({
      id: jobId,
      overallStatus: EmailJobOverallStatus.FAILED,
    });
    return;
  }

  // 3. Mark job as processing (overallStatus is already set to SENDING by the API)
  await emailJobRepository.update({
    id: jobId,
    status: EmailJobStatus.PROCESSING,
  });

  try {
    // 4. Build recipient list based on payload options
    let recipients: Recipient[];

    // Use payload recipientFilter if provided, otherwise fall back to job's recipientFilter
    const effectiveRecipientFilter = payloadRecipientFilter || job.recipientFilter;

    // Option 1: Test mode with test recipients - redirect all emails to test addresses
    if (testMode && testRecipients?.length) {
      // Build the real recipient list first to get "originalRecipient" info
      const realRecipients = userIds?.length
        ? await buildRecipientListForUserIds(userIds, logger)
        : await buildRecipientListFromFilter(effectiveRecipientFilter, logger);

      logger.info(
        `Test mode: ${realRecipients.length} real recipients, redirecting to ${testRecipients.length} test addresses`
      );

      // Create test recipients with original recipient tracking
      // Preserve original recipient ID and type so we can look up user data for personalization
      recipients = [];
      for (let i = 0; i < realRecipients.length; i++) {
        const realRecipient = realRecipients[i];
        const testEmail = testRecipients[i % testRecipients.length]; // Round-robin test addresses
        recipients.push({
          id: realRecipient.id, // Preserve original ID for user data lookup
          type: realRecipient.type, // Preserve type (user/subscriber) for correct data fetch
          email: testEmail.toLowerCase().trim(), // Actual delivery address is the test email
          originalRecipient: realRecipient.email, // Track original for display/personalization
          isTestEmail: true,
        });
      }
    }
    // Option 2: Specific userIds provided (partial send)
    else if (userIds?.length) {
      recipients = await buildRecipientListForUserIds(userIds, logger);
      logger.info(`Sending to ${recipients.length} specific users`);
    }
    // Option 3: Use recipientFilter (full send)
    else {
      recipients = await buildRecipientListFromFilter(effectiveRecipientFilter, logger);
      logger.info(`Found ${recipients.length} total recipients from filter`);
    }

    // 5. Filter out unsubscribed recipients (skip for test mode)
    let eligibleRecipients: Recipient[];
    if (testMode) {
      eligibleRecipients = recipients;
      logger.info(`Test mode: skipping unsubscribe filtering`);
    } else {
      eligibleRecipients = await filterUnsubscribed(recipients, job.category);
      logger.info(`${eligibleRecipients.length} eligible recipients after filtering unsubscribes`);
    }

    if (eligibleRecipients.length === 0) {
      logger.info('No eligible recipients, marking send as complete');
      await emailJobRepository.update({
        id: jobId,
        status: EmailJobStatus.COMPLETED,
        overallStatus: EmailJobOverallStatus.COMPLETE,
        completedAt: new Date(),
      });
      return;
    }

    // 6. Create send attempts with test mode info
    const attempts = await createSendAttempts(jobId, eligibleRecipients, {
      isTestEmail: testMode || false,
      testSubjectIndicator: testSubjectIndicator || false,
      sentBy: triggeredBy,
    });
    logger.info(`Created ${attempts.length} send attempts`);

    // 7. Update job recipient count (increment for reusable campaigns)
    const newRecipientCount = (job.recipientCount || 0) + attempts.length;
    await emailJobRepository.update({
      id: jobId,
      recipientCount: newRecipientCount,
    });

    // 8. Fan out to batch queue using SQS batch sending for efficiency
    const batches = chunkArray(attempts, EMAILS_PER_BATCH);
    logger.info(`Fanning out ${batches.length} batches to queue (${attempts.length} total emails)`);

    const sqs = new SQSClient({});
    const queueUrl = Resource.emailBatchQueue.url;

    // Send batches in groups of SQS_BATCH_SIZE (AWS limit is 10 per SendMessageBatch)
    for (let batchSetIndex = 0; batchSetIndex < batches.length; batchSetIndex += SQS_BATCH_SIZE) {
      const batchSet = batches.slice(batchSetIndex, batchSetIndex + SQS_BATCH_SIZE);

      const entries = batchSet.map((batch, indexInSet) => {
        const globalBatchIndex = batchSetIndex + indexInSet;
        return {
          Id: `batch-${jobId.slice(-8)}-${globalBatchIndex}`,
          MessageBody: JSON.stringify({
            jobId,
            attemptIds: batch.map(a => a.id),
            templateId: template.id,
            batchIndex: globalBatchIndex,
            totalBatches: batches.length,
          }),
        };
      });

      await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: entries,
        })
      );

      logger.info(
        `Queued batch set ${Math.floor(batchSetIndex / SQS_BATCH_SIZE) + 1}/${Math.ceil(batches.length / SQS_BATCH_SIZE)} with ${entries.length} batches`
      );
    }

    logger.info(`Successfully queued ${batches.length} batches for parallel processing`);
  } catch (error) {
    logger.error('Failed to orchestrate email job', error);
    await emailJobRepository.update({
      id: jobId,
      status: EmailJobStatus.FAILED,
      overallStatus: EmailJobOverallStatus.FAILED,
    });
    throw error;
  }
});

async function buildRecipientListFromFilter(
  filter: z.infer<typeof RecipientFilterSchema> | undefined,
  logger: { info: (msg: string) => void }
): Promise<Recipient[]> {
  const recipients: Recipient[] = [];
  const seenEmails = new Set<string>();

  if (!filter) {
    logger.info('No recipient filter provided, returning empty list');
    return recipients;
  }

  // All registered users (include all users with emails)
  // Use pagination to avoid loading all users into memory at once
  if (filter.allUsers) {
    logger.info('Fetching all registered users');
    const PAGE_SIZE = 1000;
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      const users = await userRepository.find({ deletedAt: null }, { skip: page * PAGE_SIZE, limit: PAGE_SIZE });

      for (const user of users) {
        if (user.email && !seenEmails.has(user.email.toLowerCase())) {
          recipients.push({ id: user.id, type: 'user', email: user.email });
          seenEmails.add(user.email.toLowerCase());
        }
      }

      hasMore = users.length === PAGE_SIZE;
      page++;
    }
    logger.info(`Found ${recipients.length} registered users with emails`);
  }

  // Specific users
  if (filter.userIds?.length) {
    logger.info(`Fetching ${filter.userIds.length} specific users`);
    for (const userId of filter.userIds) {
      const user = await userRepository.findById(userId);
      if (user?.email && !seenEmails.has(user.email.toLowerCase())) {
        recipients.push({ id: userId, type: 'user', email: user.email });
        seenEmails.add(user.email.toLowerCase());
      }
    }
  }

  // All subscribers (newsletter subscribers)
  // Use pagination to avoid loading all subscribers into memory at once
  if (filter.allSubscribers || filter.all) {
    logger.info('Fetching all newsletter subscribers');
    const PAGE_SIZE = 1000;
    let page = 0;
    let hasMore = true;
    let subCount = 0;

    while (hasMore) {
      const subs = await subscriberRepository.find({ deletedAt: null }, { skip: page * PAGE_SIZE, limit: PAGE_SIZE });

      for (const sub of subs) {
        if (sub.email && !seenEmails.has(sub.email.toLowerCase())) {
          recipients.push({ id: sub.id, type: 'subscriber', email: sub.email });
          seenEmails.add(sub.email.toLowerCase());
          subCount++;
        }
      }

      hasMore = subs.length === PAGE_SIZE;
      page++;
    }
    logger.info(`Found ${subCount} newsletter subscribers (after deduplication)`);
  }

  // Specific subscribers
  if (filter.subscriberIds?.length) {
    logger.info(`Fetching ${filter.subscriberIds.length} specific subscribers`);
    for (const subId of filter.subscriberIds) {
      const sub = await subscriberRepository.findById(subId);
      if (sub?.email && !seenEmails.has(sub.email.toLowerCase())) {
        recipients.push({ id: subId, type: 'subscriber', email: sub.email });
        seenEmails.add(sub.email.toLowerCase());
      }
    }
  }

  // Specific email addresses - check if they match existing users/subscribers first
  if (filter.specificEmails?.length) {
    // Flatten array in case any element contains multiple comma/newline separated emails
    const flattenedEmails = filter.specificEmails.flatMap(email =>
      email
        .split(/[\n,;]+/)
        .map(e => e.trim().toLowerCase())
        .filter(e => e && e.includes('@'))
    );

    logger.info(
      `Processing ${flattenedEmails.length} specific email addresses (from ${filter.specificEmails.length} entries)`
    );
    let userCount = 0;
    let subscriberCount = 0;
    let directCount = 0;

    for (const normalizedEmail of flattenedEmails) {
      if (normalizedEmail && normalizedEmail.includes('@') && !seenEmails.has(normalizedEmail)) {
        // Try to find matching user first (for personalization data)
        const matchingUser = await userRepository.findByEmail(normalizedEmail);
        if (matchingUser) {
          recipients.push({ id: matchingUser.id, type: 'user', email: matchingUser.email! });
          seenEmails.add(normalizedEmail);
          userCount++;
          continue;
        }

        // Try to find matching subscriber
        const matchingSubscriber = await subscriberRepository.findByEmail(normalizedEmail);
        if (matchingSubscriber) {
          recipients.push({ id: matchingSubscriber.id, type: 'subscriber', email: matchingSubscriber.email });
          seenEmails.add(normalizedEmail);
          subscriberCount++;
          continue;
        }

        // Fallback to direct email (not in system)
        recipients.push({ id: randomUUID(), type: 'direct', email: normalizedEmail });
        seenEmails.add(normalizedEmail);
        directCount++;
      }
    }
    logger.info(`Added specific emails: ${userCount} users, ${subscriberCount} subscribers, ${directCount} direct`);
  }

  return recipients;
}

async function buildRecipientListForUserIds(
  userIds: string[],
  logger: { info: (msg: string) => void }
): Promise<Recipient[]> {
  const recipients: Recipient[] = [];
  const seenEmails = new Set<string>();

  logger.info(`Fetching ${userIds.length} specific users by ID`);

  for (const userId of userIds) {
    const user = await userRepository.findById(userId);
    if (user?.email && !seenEmails.has(user.email.toLowerCase())) {
      recipients.push({ id: userId, type: 'user', email: user.email });
      seenEmails.add(user.email.toLowerCase());
    }
  }

  logger.info(`Found ${recipients.length} users with valid emails`);
  return recipients;
}

async function filterUnsubscribed(recipients: Recipient[], category: string): Promise<Recipient[]> {
  const result: Recipient[] = [];

  for (const recipient of recipients) {
    const prefs = await emailPreferencesRepository.findByEmail(recipient.email);

    // No preferences = subscribed to everything
    if (!prefs) {
      result.push(recipient);
      continue;
    }

    // Check global unsubscribe
    if (prefs.globalUnsubscribe) {
      continue;
    }

    // Check category-specific unsubscribe
    if (prefs.unsubscribedCategories.includes(category as any)) {
      continue;
    }

    result.push(recipient);
  }

  return result;
}

async function createSendAttempts(
  jobId: string,
  recipients: Recipient[],
  options: SendAttemptOptions
): Promise<Array<{ id: string }>> {
  const attempts: Array<{ id: string }> = [];

  for (const recipient of recipients) {
    const attempt = await emailSendAttemptRepository.create({
      jobId,
      recipientId: recipient.id,
      recipientType: recipient.type,
      recipientEmail: recipient.email,
      status: EmailSendStatus.PENDING,
      trackingToken: randomUUID(),
      retryCount: 0,
      isTestEmail: recipient.isTestEmail || options.isTestEmail,
      originalRecipient: recipient.originalRecipient,
      testSubjectIndicator: options.testSubjectIndicator,
      sentBy: options.sentBy,
    });
    attempts.push({ id: attempt.id });
  }

  return attempts;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

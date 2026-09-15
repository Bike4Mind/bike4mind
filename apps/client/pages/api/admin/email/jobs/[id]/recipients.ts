import {
  emailJobRepository,
  userRepository,
  subscriberRepository,
  emailPreferencesRepository,
  emailSendAttemptRepository,
} from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';

interface RecipientWithStatus {
  id: string;
  email: string;
  name?: string;
  type: 'user' | 'subscriber' | 'direct';
  lastSentAt?: Date;
  sendCount: number;
}

/**
 * GET /api/admin/email/jobs/:id/recipients
 *
 * Get list of recipients for a job based on its recipientFilter.
 * Includes send status for each recipient.
 */
const handler = baseApi().get(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const { id } = req.query as { id: string };
  const { page = '1', limit = '50', search } = req.query as { page?: string; limit?: string; search?: string };

  const pageNum = parseInt(page, 10) || 1;
  const limitNum = Math.min(parseInt(limit, 10) || 50, 100); // Max 100 per page

  const job = await emailJobRepository.findById(id);
  if (!job) {
    throw new NotFoundError('Job not found');
  }

  const recipientFilter = job.recipientFilter;
  if (!recipientFilter) {
    return res.json({
      recipients: [],
      meta: {
        currentPage: 1,
        totalPages: 0,
        total: 0,
      },
    });
  }

  // Build full recipient list (same logic as preview-recipients)
  const recipients: RecipientWithStatus[] = [];
  const seenEmails = new Set<string>();

  // All registered users
  if (recipientFilter.allUsers) {
    const users = await userRepository.find({ deletedAt: null });
    for (const user of users) {
      if (user.email && user.emailVerified && !seenEmails.has(user.email.toLowerCase())) {
        recipients.push({
          id: user.id,
          email: user.email,
          name: user.name || user.email.split('@')[0],
          type: 'user',
          sendCount: 0,
        });
        seenEmails.add(user.email.toLowerCase());
      }
    }
  }

  // Specific users
  if (recipientFilter.userIds?.length) {
    for (const userId of recipientFilter.userIds) {
      const user = await userRepository.findById(userId);
      if (user?.email && !seenEmails.has(user.email.toLowerCase())) {
        recipients.push({
          id: user.id,
          email: user.email,
          name: user.name || user.email.split('@')[0],
          type: 'user',
          sendCount: 0,
        });
        seenEmails.add(user.email.toLowerCase());
      }
    }
  }

  // All subscribers
  if (recipientFilter.allSubscribers || recipientFilter.all) {
    const subs = await subscriberRepository.find({ deletedAt: null });
    for (const sub of subs) {
      if (sub.email && !seenEmails.has(sub.email.toLowerCase())) {
        recipients.push({
          id: sub.id,
          email: sub.email,
          name: sub.email.split('@')[0],
          type: 'subscriber',
          sendCount: 0,
        });
        seenEmails.add(sub.email.toLowerCase());
      }
    }
  }

  // Specific subscribers
  if (recipientFilter.subscriberIds?.length) {
    for (const subId of recipientFilter.subscriberIds) {
      const sub = await subscriberRepository.findById(subId);
      if (sub?.email && !seenEmails.has(sub.email.toLowerCase())) {
        recipients.push({
          id: sub.id,
          email: sub.email,
          name: sub.email.split('@')[0],
          type: 'subscriber',
          sendCount: 0,
        });
        seenEmails.add(sub.email.toLowerCase());
      }
    }
  }

  // Specific email addresses
  if (recipientFilter.specificEmails?.length) {
    for (const email of recipientFilter.specificEmails) {
      const normalizedEmail = email.toLowerCase().trim();
      if (normalizedEmail && normalizedEmail.includes('@') && !seenEmails.has(normalizedEmail)) {
        recipients.push({
          id: normalizedEmail, // Use email as ID for direct emails
          email: normalizedEmail,
          name: normalizedEmail.split('@')[0],
          type: 'direct',
          sendCount: 0,
        });
        seenEmails.add(normalizedEmail);
      }
    }
  }

  // Filter out unsubscribed
  const eligibleRecipients: RecipientWithStatus[] = [];
  for (const recipient of recipients) {
    const prefs = await emailPreferencesRepository.findByEmail(recipient.email);

    // No preferences = subscribed to everything
    if (!prefs) {
      eligibleRecipients.push(recipient);
      continue;
    }

    // Check global unsubscribe
    if (prefs.globalUnsubscribe) {
      continue;
    }

    // Check category-specific unsubscribe
    if (prefs.unsubscribedCategories.includes(job.category)) {
      continue;
    }

    eligibleRecipients.push(recipient);
  }

  // Apply search filter if provided
  let filteredRecipients = eligibleRecipients;
  if (search) {
    const searchLower = search.toLowerCase();
    filteredRecipients = eligibleRecipients.filter(
      r => r.email.toLowerCase().includes(searchLower) || r.name?.toLowerCase().includes(searchLower)
    );
  }

  // Get send status for paginated results
  const skip = (pageNum - 1) * limitNum;
  const paginatedRecipients = filteredRecipients.slice(skip, skip + limitNum);

  // Fetch send attempts for these recipients to get send status
  const recipientIds = paginatedRecipients.map(r => r.id);

  // Get send counts and last sent dates for these recipients
  const sendStatusMap = await emailSendAttemptRepository.getRecipientSendStatus(id, recipientIds);

  // Merge send status into recipients
  const recipientsWithStatus = paginatedRecipients.map(r => {
    const status = sendStatusMap.get(r.id);
    return {
      ...r,
      sendCount: status?.sendCount || 0,
      lastSentAt: status?.lastSentAt,
    };
  });

  return res.json({
    recipients: recipientsWithStatus,
    meta: {
      currentPage: pageNum,
      totalPages: Math.ceil(filteredRecipients.length / limitNum),
      total: filteredRecipients.length,
      totalEligible: eligibleRecipients.length,
      totalAll: recipients.length,
    },
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

import { userRepository, subscriberRepository, emailPreferencesRepository } from '@bike4mind/database';
import { EmailCategory, IEmailRecipientFilter } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { randomUUID } from 'crypto';

interface PreviewRecipient {
  id: string;
  email: string;
  name?: string;
  type: 'user' | 'subscriber' | 'direct';
}

const handler = baseApi().post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const { recipientFilter, category } = req.body as {
    recipientFilter?: IEmailRecipientFilter;
    category?: EmailCategory;
  };

  if (!recipientFilter) {
    throw new BadRequestError('recipientFilter is required');
  }

  const recipients: PreviewRecipient[] = [];
  const seenEmails = new Set<string>();

  // All registered users (include all users with emails, regardless of verification status)
  if (recipientFilter.allUsers) {
    const users = await userRepository.find({ deletedAt: null });
    for (const user of users) {
      if (user.email && !seenEmails.has(user.email.toLowerCase())) {
        recipients.push({
          id: user.id,
          email: user.email,
          name: user.name || user.email.split('@')[0],
          type: 'user',
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
        });
        seenEmails.add(sub.email.toLowerCase());
      }
    }
  }

  // Specific email addresses - check if they match existing users/subscribers first
  if (recipientFilter.specificEmails?.length) {
    for (const email of recipientFilter.specificEmails) {
      const normalizedEmail = email.toLowerCase().trim();
      if (normalizedEmail && normalizedEmail.includes('@') && !seenEmails.has(normalizedEmail)) {
        // Try to find matching user first
        const matchingUser = await userRepository.findByEmail(normalizedEmail);
        if (matchingUser) {
          recipients.push({
            id: matchingUser.id,
            email: matchingUser.email!,
            name: matchingUser.name || normalizedEmail.split('@')[0],
            type: 'user',
          });
          seenEmails.add(normalizedEmail);
          continue;
        }

        // Try to find matching subscriber
        const matchingSubscriber = await subscriberRepository.findByEmail(normalizedEmail);
        if (matchingSubscriber) {
          const fullName = [matchingSubscriber.firstName, matchingSubscriber.lastName].filter(Boolean).join(' ');
          recipients.push({
            id: matchingSubscriber.id,
            email: matchingSubscriber.email,
            name: fullName || normalizedEmail.split('@')[0],
            type: 'subscriber',
          });
          seenEmails.add(normalizedEmail);
          continue;
        }

        // Fallback to direct email (not in system)
        recipients.push({
          id: randomUUID(),
          email: normalizedEmail,
          name: normalizedEmail.split('@')[0],
          type: 'direct',
        });
        seenEmails.add(normalizedEmail);
      }
    }
  }

  // Filter out unsubscribed if category provided
  let filteredRecipients = recipients;
  if (category) {
    filteredRecipients = [];
    for (const recipient of recipients) {
      const prefs = await emailPreferencesRepository.findByEmail(recipient.email);

      // No preferences = subscribed to everything
      if (!prefs) {
        filteredRecipients.push(recipient);
        continue;
      }

      // Check global unsubscribe
      if (prefs.globalUnsubscribe) {
        continue;
      }

      // Check category-specific unsubscribe
      if (prefs.unsubscribedCategories.includes(category)) {
        continue;
      }

      filteredRecipients.push(recipient);
    }
  }

  return res.json({
    totalCount: recipients.length,
    eligibleCount: filteredRecipients.length,
    excludedCount: recipients.length - filteredRecipients.length,
    recipients: filteredRecipients.slice(0, 100), // Limit to first 100 for preview
    hasMore: filteredRecipients.length > 100,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

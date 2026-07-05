import { emailPreferencesRepository, emailSendAttemptRepository } from '@bike4mind/database';
import { EmailCategory } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';

const handler = baseApi({ auth: false })
  .get(async (req, res) => {
    const { token } = req.query as { token: string };

    if (!token) {
      throw new BadRequestError('Token is required');
    }

    // Find attempt by tracking token to get email
    const attempt = await emailSendAttemptRepository.findByTrackingToken(token);
    if (!attempt) {
      throw new BadRequestError('Invalid or expired token');
    }

    // Get or create preferences
    const prefs = await emailPreferencesRepository.findOrCreate(attempt.recipientEmail);

    return res.json({
      email: attempt.recipientEmail,
      preferences: {
        unsubscribedCategories: prefs.unsubscribedCategories,
        globalUnsubscribe: prefs.globalUnsubscribe,
      },
      categories: Object.values(EmailCategory),
    });
  })
  .post(async (req, res) => {
    const { token } = req.query as { token: string };
    const { category, globalUnsubscribe } = req.body as {
      category?: EmailCategory;
      globalUnsubscribe?: boolean;
    };

    if (!token) {
      throw new BadRequestError('Token is required');
    }

    // Find attempt by tracking token to get email
    const attempt = await emailSendAttemptRepository.findByTrackingToken(token);
    if (!attempt) {
      throw new BadRequestError('Invalid or expired token');
    }

    if (globalUnsubscribe) {
      await emailPreferencesRepository.globalUnsubscribe(attempt.recipientEmail);
      return res.json({
        success: true,
        message: 'You have been unsubscribed from all emails',
      });
    }

    if (category) {
      await emailPreferencesRepository.unsubscribeFromCategory(attempt.recipientEmail, category);
      return res.json({
        success: true,
        message: `You have been unsubscribed from ${category} emails`,
      });
    }

    throw new BadRequestError('Either category or globalUnsubscribe is required');
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

import type { IncomingHttpHeaders } from 'node:http';
import { emailPreferencesRepository, emailSendAttemptRepository } from '@bike4mind/database';
import { EmailCategory } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import * as z from 'zod';

const unsubscribeBodySchema = z.object({
  category: z.nativeEnum(EmailCategory).optional(),
  globalUnsubscribe: z.boolean().optional(),
});

/** Request header carrying the email's tracking token; the unsubscribe page reads it from its link. */
const UNSUBSCRIBE_TOKEN_HEADER = 'x-unsubscribe-token';

const readToken = (headers: IncomingHttpHeaders): string | undefined => {
  const value = headers[UNSUBSCRIBE_TOKEN_HEADER];
  return typeof value === 'string' && value ? value : undefined;
};

const handler = baseApi({ auth: false })
  .get(async (req, res) => {
    const token = readToken(req.headers);

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
    const token = readToken(req.headers);
    const { category, globalUnsubscribe } = unsubscribeBodySchema.parse(req.body ?? {});

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

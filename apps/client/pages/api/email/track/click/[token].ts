import { emailSendAttemptRepository, emailJobRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { z } from 'zod';
import { isIssuedTrackingLink } from '@server/services/email/issuedTrackingLink';

const QuerySchema = z.object({ token: z.string().uuid(), url: z.string().min(1).max(8192) });

const handler = baseApi({ auth: false }).get(async (req, res) => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) throw new BadRequestError('Invalid tracking link');
  const { token, url } = parsed.data;

  // Validate URL to prevent open redirect vulnerability
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new BadRequestError('Invalid URL');
  }

  // Only allow http/https redirects (block javascript:, data:, etc.)
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new BadRequestError('Invalid URL protocol');
  }

  const issuedAttempt = await emailSendAttemptRepository.findByTrackingToken(token);
  if (!issuedAttempt?.renderedHtml || !isIssuedTrackingLink(issuedAttempt.renderedHtml, token, url)) {
    return res.status(404).end();
  }
  const attempt = await emailSendAttemptRepository.recordClick(token, url);
  if (!attempt) return res.status(404).end();
  try {
    await emailJobRepository.incrementCounts(attempt.jobId, 'clickedCount');
  } catch (error) {
    console.error('Failed to count verified email click:', error);
  }

  // Redirect to the original URL
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  return res.redirect(302, url);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

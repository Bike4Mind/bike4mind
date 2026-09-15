import { emailSendAttemptRepository, emailJobRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';

const handler = baseApi({ auth: false }).get(async (req, res) => {
  const { token, url } = req.query as { token: string; url?: string };

  if (!url) {
    throw new BadRequestError('URL parameter is required');
  }

  const decodedUrl = decodeURIComponent(url);

  // Validate URL to prevent open redirect vulnerability
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(decodedUrl);
  } catch {
    throw new BadRequestError('Invalid URL');
  }

  // Only allow http/https redirects (block javascript:, data:, etc.)
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new BadRequestError('Invalid URL protocol');
  }

  try {
    const attempt = await emailSendAttemptRepository.recordClick(token, decodedUrl);
    if (attempt) {
      await emailJobRepository.incrementCounts(attempt.jobId, 'clickedCount');
    }
  } catch (error) {
    // Log error but still redirect
    console.error('Failed to track email click:', error);
  }

  // Redirect to the original URL
  return res.redirect(302, decodedUrl);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

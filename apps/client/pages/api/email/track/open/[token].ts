import { emailSendAttemptRepository, emailJobRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';

// 1x1 transparent GIF
const TRACKING_PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const handler = baseApi({ auth: false }).get(async (req, res) => {
  const { token } = req.query as { token: string };

  try {
    const attempt = await emailSendAttemptRepository.markOpened(token);
    if (attempt) {
      await emailJobRepository.incrementCounts(attempt.jobId, 'openedCount');
    }
  } catch (error) {
    // Silently fail - don't break email display
    console.error('Failed to track email open:', error);
  }

  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  return res.send(TRACKING_PIXEL);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { getPreviewSleepStatus, isPreviewSleepEnabled, wakePreview } from '@server/previewSleep/previewSleep';

// Preview-only: reports whether this stage's ECS services are scaled to zero and wakes them.
// Plain HTTP on purpose, since the realtime socket is one of the services that sleeps.
const handler = baseApi({ auth: 'jwtOnly', allowedMethods: ['GET', 'POST'] })
  // Ahead of rateLimit so other stages never write a rate-limit bucket for this route.
  .use((_req, res, next) => (isPreviewSleepEnabled() ? next() : res.status(404).json({ error: 'Not found' })))
  .use(rateLimit({ limit: 30, windowMs: 60 * 1000 }))
  .get(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      return res.status(200).json(await getPreviewSleepStatus());
    } catch (error) {
      // AWS errors name the account, role and target ARN, so they stay in the log.
      req.logger.error('Preview sleep status lookup failed', { error });
      return res.status(502).json({ error: 'Preview status is unavailable' });
    }
  })
  .post(async (req, res) => {
    try {
      await wakePreview();
    } catch (error) {
      req.logger.error('Preview wake failed', { error });
      return res.status(502).json({ error: 'Could not wake the preview' });
    }
    return res.status(202).json({ waking: true });
  });

export default handler;

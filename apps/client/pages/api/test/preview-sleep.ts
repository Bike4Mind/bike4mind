import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { isE2EEnabled } from '@bike4mind/server-utils/utils/config';
import { isValidE2eTestSecret } from '@server/auth/e2eTestSecret';
import { getPreviewSleepStatus, isPreviewSleepEnabled, wakePreview } from '@server/previewSleep/previewSleep';

/**
 * TEST-ONLY: the secret-gated twin of /api/preview-sleep, so the CI e2e workflow can wake a
 * sleeping preview before its suite starts. .github/scripts/preview-e2e.cjs (ensureAwake) calls it
 * and reads 404 as "this preview has no sleep route", so a disabled stage must stay a 404.
 */
const handler = baseApi({ auth: false, allowedMethods: ['GET', 'POST'] })
  .use((_req, res, next) => (isE2EEnabled() ? next() : res.status(403).json({ error: 'Forbidden' })))
  // Ahead of rateLimit so other stages never write a rate-limit bucket for this route.
  .use((_req, res, next) => (isPreviewSleepEnabled() ? next() : res.status(404).json({ error: 'Not found' })))
  // Ahead of the secret check so guessing the secret is throttled too.
  .use(rateLimit({ limit: 30, windowMs: 60 * 1000 }))
  .use((req, res, next) =>
    isValidE2eTestSecret(req.headers['x-e2e-cleanup-secret'])
      ? next()
      : res.status(401).json({ error: 'Invalid cleanup secret' })
  )
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

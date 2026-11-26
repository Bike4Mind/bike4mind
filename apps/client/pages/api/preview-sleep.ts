import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { getPreviewSleepStatus, isPreviewSleepEnabled, wakePreview } from '@server/previewSleep/previewSleep';

// Preview-only: reports whether this stage's ECS services are scaled to zero and wakes them.
// Plain HTTP on purpose, since the realtime socket is one of the services that sleeps.
const handler = baseApi({ auth: 'jwtOnly', allowedMethods: ['GET', 'POST'] })
  .use(rateLimit({ limit: 30, windowMs: 60 * 1000 }))
  .get(async (_req, res) => {
    if (!isPreviewSleepEnabled()) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(await getPreviewSleepStatus());
  })
  .post(async (_req, res) => {
    if (!isPreviewSleepEnabled()) return res.status(404).json({ error: 'Not found' });
    await wakePreview();
    return res.status(202).json({ waking: true });
  });

export default handler;

import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { customPageRepository } from '@bike4mind/database';
import { customPageService } from '@bike4mind/services';
import { PageIdSchema, PatchPageStateInput } from '@bike4mind/common';
import { sendPageResult } from '@server/customPages/sendPageResult';

/** PATCH /api/pages/:id/state - apply a JSON merge patch (`{ patch }`) to the page's state. */
const handler = baseApi({ auth: 'jwtOnly', allowedMethods: ['PATCH'] })
  .use(requireFeatureEnabled('EnableCustomPages'))
  .use(rateLimit({ limit: 60, windowMs: 60 * 1000, bucket: 'pages/[id]/state' }))
  .patch(csrfProtection(), async (req, res) => {
    const id = PageIdSchema.safeParse(req.query.id);
    if (!id.success) return res.status(400).json({ error: 'Invalid page id' });
    const parsed = PatchPageStateInput.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid state patch', details: parsed.error.flatten() });
    }
    const result = await customPageService.patchState(
      { pageId: id.data, userId: req.user.id, patch: parsed.data.patch },
      { db: { customPages: customPageRepository } }
    );
    return sendPageResult(res, result);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

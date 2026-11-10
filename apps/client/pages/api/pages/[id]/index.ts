import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { respond } from '@server/utils/respond';
import { pageResponseSchema } from '@server/customPages/sendPageResult';
import { customPageRepository } from '@bike4mind/database';
import { PageIdSchema, UpdateCustomPageInput } from '@bike4mind/common';

/**
 * GET    /api/pages/:id - the full page (state and widgets).
 * PATCH  /api/pages/:id - rename or change icon/description.
 * DELETE /api/pages/:id - soft delete. The orchestrator session is kept; its surface keeps it out
 *        of the notebook list.
 */
const handler = baseApi({ auth: 'jwtOnly', allowedMethods: ['GET', 'PATCH', 'DELETE'] })
  .use(requireFeatureEnabled('EnableCustomPages'))
  // Stable bucket - without it the [id] segment would give each page its own counter.
  .use(rateLimit({ limit: 120, windowMs: 60 * 1000, bucket: 'pages/[id]' }))
  .get(async (req, res) => {
    const id = PageIdSchema.safeParse(req.query.id);
    if (!id.success) return res.status(400).json({ error: 'Invalid page id' });
    const page = await customPageRepository.findOwned(id.data, req.user.id);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    return respond(res, pageResponseSchema, { page });
  })
  .patch(csrfProtection(), async (req, res) => {
    const id = PageIdSchema.safeParse(req.query.id);
    if (!id.success) return res.status(400).json({ error: 'Invalid page id' });
    const parsed = UpdateCustomPageInput.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid update', details: parsed.error.flatten() });
    }
    const page = await customPageRepository.updateMetaOwned(id.data, req.user.id, parsed.data);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    return respond(res, pageResponseSchema, { page });
  })
  .delete(csrfProtection(), async (req, res) => {
    const id = PageIdSchema.safeParse(req.query.id);
    if (!id.success) return res.status(400).json({ error: 'Invalid page id' });
    const deleted = await customPageRepository.softDeleteOwned(id.data, req.user.id);
    if (!deleted) return res.status(404).json({ error: 'Page not found' });
    return res.status(204).end();
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

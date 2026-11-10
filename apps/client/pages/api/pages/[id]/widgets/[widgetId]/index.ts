import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { customPageRepository } from '@bike4mind/database';
import { customPageService } from '@bike4mind/services';
import { PAGE_WIDGET_ID, PageIdSchema } from '@bike4mind/common';
import { sendPageResult } from '@server/customPages/sendPageResult';

/**
 * PUT    /api/pages/:id/widgets/:widgetId - create or replace a widget (body: a PageWidget; its `id`
 *        defaults to the path segment and must match it when given).
 * DELETE /api/pages/:id/widgets/:widgetId - remove a widget.
 */
const handler = baseApi({ auth: 'jwtOnly', allowedMethods: ['PUT', 'DELETE'] })
  .use(requireFeatureEnabled('EnableCustomPages'))
  .use(rateLimit({ limit: 60, windowMs: 60 * 1000, bucket: 'pages/[id]/widgets/[widgetId]' }))
  .put(csrfProtection(), async (req, res) => {
    const id = PageIdSchema.safeParse(req.query.id);
    const widgetId = PAGE_WIDGET_ID.safeParse(req.query.widgetId);
    if (!id.success || !widgetId.success) return res.status(400).json({ error: 'Invalid page or widget id' });

    const body: unknown = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return res.status(400).json({ error: 'Invalid widget' });
    }
    const bodyId = (body as { id?: unknown }).id;
    if (bodyId !== undefined && bodyId !== widgetId.data) {
      return res.status(400).json({ error: 'Widget id does not match the URL' });
    }

    const result = await customPageService.setWidget(
      { pageId: id.data, userId: req.user.id, widget: { ...body, id: widgetId.data } },
      { db: { customPages: customPageRepository } }
    );
    return sendPageResult(res, result);
  })
  .delete(csrfProtection(), async (req, res) => {
    const id = PageIdSchema.safeParse(req.query.id);
    const widgetId = PAGE_WIDGET_ID.safeParse(req.query.widgetId);
    if (!id.success || !widgetId.success) return res.status(400).json({ error: 'Invalid page or widget id' });

    const result = await customPageService.removeWidget(
      { pageId: id.data, userId: req.user.id, widgetId: widgetId.data },
      { db: { customPages: customPageRepository } }
    );
    return sendPageResult(res, result);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

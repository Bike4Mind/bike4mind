import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { customPageRepository } from '@bike4mind/database';
import { customPageService } from '@bike4mind/services';
import { PAGE_WIDGET_ID, PageChecklistItemIdSchema, PageIdSchema, PatchChecklistItemInput } from '@bike4mind/common';
import { sendPageResult } from '@server/customPages/sendPageResult';

/** PATCH /api/pages/:id/widgets/:widgetId/items/:itemId - check or uncheck a checklist item (`{ checked }`). */
const handler = baseApi({ auth: 'jwtOnly', allowedMethods: ['PATCH'] })
  .use(requireFeatureEnabled('EnableCustomPages'))
  .use(rateLimit({ limit: 120, windowMs: 60 * 1000, bucket: 'pages/[id]/widgets/[widgetId]/items/[itemId]' }))
  .patch(csrfProtection(), async (req, res) => {
    const id = PageIdSchema.safeParse(req.query.id);
    const widgetId = PAGE_WIDGET_ID.safeParse(req.query.widgetId);
    const itemId = PageChecklistItemIdSchema.safeParse(req.query.itemId);
    if (!id.success || !widgetId.success || !itemId.success) {
      return res.status(400).json({ error: 'Invalid page, widget or item id' });
    }
    const parsed = PatchChecklistItemInput.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid checklist update', details: parsed.error.flatten() });
    }

    const result = await customPageService.toggleChecklistItem(
      {
        pageId: id.data,
        userId: req.user.id,
        widgetId: widgetId.data,
        itemId: itemId.data,
        checked: parsed.data.checked,
      },
      { db: { customPages: customPageRepository } }
    );
    return sendPageResult(res, result);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

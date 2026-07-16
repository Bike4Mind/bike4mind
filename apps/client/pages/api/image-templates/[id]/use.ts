import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@server/middlewares/rateLimit';
import { imageGenerationTemplateRepository } from '@bike4mind/database';
import { imageTemplateService } from '@bike4mind/services';
import { ImageTemplateIdSchema, type IImageTemplateCaller } from '@bike4mind/common';
import { Request } from 'express';

const toCaller = (req: Request): IImageTemplateCaller => ({
  id: req.user.id,
  isAdmin: !!req.user.isAdmin,
  isApiKey: !!req.apiKeyInfo,
});

const adapters = { db: { templates: imageGenerationTemplateRepository } };

/**
 * POST /api/image-templates/:id/use - increment usageCount, recorded when a
 * prompt is sent with a template's settings (matched client-side). Increment-only;
 * no body, returns 204.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableImageTemplates'))
  .use(rateLimit({ limit: 120, windowMs: 60 * 1000, bucket: 'image-templates/use' }))
  .post(csrfProtection(), async (req, res) => {
    const id = ImageTemplateIdSchema.safeParse(req.query.id);
    if (!id.success) return res.status(400).json({ error: 'Invalid template id' });

    await imageTemplateService.recordUse(toCaller(req), adapters, id.data);
    return res.status(204).end();
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

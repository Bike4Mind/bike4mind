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
 * POST /api/image-templates/:id/apply - bump usageCount and return the template
 * for the client to load into LLMContext.
 *
 * EXACT-MODEL backstop: an optional `model` in the body is the active model; if
 * present and it differs from the template's bound model, the service rejects
 * (422). The picker also hides mismatches, so this is defense-in-depth.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableImageTemplates'))
  .use(rateLimit({ limit: 60, windowMs: 60 * 1000, bucket: 'image-templates/apply' }))
  .post(csrfProtection(), async (req, res) => {
    const id = ImageTemplateIdSchema.safeParse(req.query.id);
    if (!id.success) return res.status(400).json({ error: 'Invalid template id' });

    const targetModel = typeof req.body?.model === 'string' ? req.body.model : undefined;
    const template = await imageTemplateService.applyTemplate(toCaller(req), adapters, id.data, targetModel);
    return res.json({ template });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

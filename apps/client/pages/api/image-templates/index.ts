import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@server/middlewares/rateLimit';
import { imageGenerationTemplateRepository } from '@bike4mind/database';
import { imageTemplateService } from '@bike4mind/services';
import { ImageGenerationTemplateInput, IMAGE_TEMPLATE_LIST_LIMIT, type IImageTemplateCaller } from '@bike4mind/common';
import { Request } from 'express';

const toCaller = (req: Request): IImageTemplateCaller => ({
  id: req.user.id,
  isAdmin: !!req.user.isAdmin,
  isApiKey: !!req.apiKeyInfo,
});

const adapters = { db: { templates: imageGenerationTemplateRepository } };

/**
 * GET  /api/image-templates      - list the caller's templates (paginated).
 * POST /api/image-templates      - create a template owned by the caller.
 * Gated by EnableImageTemplates + rate-limited. Ownership is server-bound.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableImageTemplates'))
  .use(rateLimit({ limit: 60, windowMs: 60 * 1000, bucket: 'image-templates' }))
  .get(async (req, res) => {
    // Clamp to [1, LIST_LIMIT] so a negative/zero/oversized param can't reach
    // Mongoose .limit() (a negative limit has surprising legacy cursor semantics).
    const limit = Math.max(
      1,
      Math.min(Number(req.query.limit) || IMAGE_TEMPLATE_LIST_LIMIT, IMAGE_TEMPLATE_LIST_LIMIT)
    );
    const skip = Math.max(Number(req.query.skip) || 0, 0);
    const templates = await imageTemplateService.listTemplates(toCaller(req), adapters, { limit, skip });
    return res.json({ templates });
  })
  .post(csrfProtection(), async (req, res) => {
    const parsed = ImageGenerationTemplateInput.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid template', details: parsed.error.flatten() });
    }
    const template = await imageTemplateService.saveTemplate(toCaller(req), adapters, parsed.data);
    return res.status(201).json({ template });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

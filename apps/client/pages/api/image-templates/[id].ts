import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@server/middlewares/rateLimit';
import { imageGenerationTemplateRepository } from '@bike4mind/database';
import { imageTemplateService } from '@bike4mind/services';
import {
  ImageGenerationTemplateUpdateInput,
  ImageTemplateIdSchema,
  type IImageTemplateCaller,
} from '@bike4mind/common';
import { Request } from 'express';

const toCaller = (req: Request): IImageTemplateCaller => ({
  id: req.user.id,
  isAdmin: !!req.user.isAdmin,
  isApiKey: !!req.apiKeyInfo,
});

const adapters = { db: { templates: imageGenerationTemplateRepository } };

/**
 * Per-template routes, gated by EnableImageTemplates + rate-limited.
 * GET    /api/image-templates/:id - fetch a template the caller OWNS (404 otherwise).
 * PUT    /api/image-templates/:id - update a template the caller OWNS.
 * DELETE /api/image-templates/:id - soft-delete a template the caller OWNS.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableImageTemplates'))
  // Stable bucket - without it the [id] segment would give each template its own counter.
  .use(rateLimit({ limit: 60, windowMs: 60 * 1000, bucket: 'image-templates/[id]' }))
  .get(async (req, res) => {
    const id = ImageTemplateIdSchema.safeParse(req.query.id);
    if (!id.success) return res.status(400).json({ error: 'Invalid template id' });
    const template = await imageTemplateService.getTemplate(toCaller(req), adapters, id.data);
    return res.json({ template });
  })
  .put(csrfProtection(), async (req, res) => {
    const id = ImageTemplateIdSchema.safeParse(req.query.id);
    if (!id.success) return res.status(400).json({ error: 'Invalid template id' });

    const parsed = ImageGenerationTemplateUpdateInput.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid update', details: parsed.error.flatten() });
    }
    const template = await imageTemplateService.updateTemplate(toCaller(req), adapters, id.data, parsed.data);
    return res.json({ template });
  })
  .delete(csrfProtection(), async (req, res) => {
    const id = ImageTemplateIdSchema.safeParse(req.query.id);
    if (!id.success) return res.status(400).json({ error: 'Invalid template id' });
    await imageTemplateService.deleteTemplate(toCaller(req), adapters, id.data);
    return res.status(204).end();
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

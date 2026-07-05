import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@server/middlewares/rateLimit';
import { briefcasePromptRepository } from '@bike4mind/database';
import { briefcaseService } from '@bike4mind/services';
import { BriefcasePromptIdSchema, BriefcasePromptUpdateInput, type ICaller } from '@bike4mind/common';
import { Request } from 'express';

const toCaller = (req: Request): ICaller => ({
  id: req.user.id,
  entitlements: req.user.tags ?? [],
  isAdmin: !!req.user.isAdmin,
  isApiKey: !!req.apiKeyInfo,
});

/**
 * Per-prompt routes, all gated by EnableBriefcase + rate-limited.
 *
 * GET    /api/briefcase/prompts/:id - authoritative click-time refetch. Returns
 *        the FULL prompt (incl. promptText) only if it's a system prompt the caller
 *        is ENTITLED to see (same visibility scoping as the catalog) or one owned
 *        by the caller; 404 otherwise (never another user's personal prompt, and no
 *        by-id bypass of visibilityScopes).
 * PUT    /api/briefcase/prompts/:id - update a prompt the caller OWNS.
 * DELETE /api/briefcase/prompts/:id - soft-delete a prompt the caller OWNS.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableBriefcase'))
  // Stable bucket - without it the [id] segment would give each prompt its own counter.
  .use(rateLimit({ limit: 60, windowMs: 60 * 1000, bucket: 'briefcase/prompts/[id]' }))
  .get(async (req, res) => {
    const id = BriefcasePromptIdSchema.safeParse(req.query.id);
    if (!id.success) return res.status(400).json({ error: 'Invalid prompt id' });

    const prompt = await briefcasePromptRepository.findByIdForCaller(id.data, req.user.id);
    if (!prompt) return res.status(404).json({ error: 'Prompt not found' });
    // System prompts must pass the SAME visibility gate as the catalog - otherwise
    // the by-id path leaks entitlement-scoped promptText/tools to non-entitled callers.
    // (Personal prompts are already owner-scoped by findByIdForCaller.)
    if (prompt.userId == null && !briefcaseService.canSeeSystemPrompt(prompt, toCaller(req))) {
      return res.status(404).json({ error: 'Prompt not found' });
    }
    return res.json({ prompt });
  })
  .put(csrfProtection(), async (req, res) => {
    if (req.apiKeyInfo) return res.status(403).json({ error: 'API keys cannot edit personal prompts' });
    const id = BriefcasePromptIdSchema.safeParse(req.query.id);
    if (!id.success) return res.status(400).json({ error: 'Invalid prompt id' });

    const parsed = BriefcasePromptUpdateInput.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid update', details: parsed.error.flatten() });
    }

    const updated = await briefcasePromptRepository.updateOwned(id.data, req.user.id, parsed.data);
    if (!updated) return res.status(404).json({ error: 'Prompt not found' });
    return res.json({ prompt: updated });
  })
  .delete(csrfProtection(), async (req, res) => {
    if (req.apiKeyInfo) return res.status(403).json({ error: 'API keys cannot delete personal prompts' });
    const id = BriefcasePromptIdSchema.safeParse(req.query.id);
    if (!id.success) return res.status(400).json({ error: 'Invalid prompt id' });

    const deleted = await briefcasePromptRepository.softDeleteOwned(id.data, req.user.id);
    if (!deleted) return res.status(404).json({ error: 'Prompt not found' });
    return res.status(204).end();
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

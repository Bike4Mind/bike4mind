import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@server/middlewares/rateLimit';
import { briefcasePromptRepository } from '@bike4mind/database';
import { BriefcasePromptInput } from '@bike4mind/common';

/**
 * POST /api/briefcase/prompts - create a PERSONAL prompt owned by the caller.
 * Ownership is bound to the authenticated user server-side; `userId` is never
 * accepted from the body. API-key callers may not author personal prompts.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableBriefcase'))
  .use(rateLimit({ limit: 30, windowMs: 60 * 1000 }))
  .post(csrfProtection(), async (req, res) => {
    if (req.apiKeyInfo) {
      return res.status(403).json({ error: 'API keys cannot author personal prompts' });
    }
    const parsed = BriefcasePromptInput.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid prompt', details: parsed.error.flatten() });
    }

    const created = await briefcasePromptRepository.create({
      ...parsed.data,
      userId: req.user.id, // server-bound ownership
      visibilityScopes: [], // personal prompts are not entitlement-scoped
      schemaVersion: 1,
      deletedAt: null,
    } as Parameters<typeof briefcasePromptRepository.create>[0]);

    return res.status(201).json({ prompt: created });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@server/middlewares/rateLimit';
import { briefcaseService } from '@bike4mind/services';
import { briefcasePromptRepository } from '@bike4mind/database';
import { BriefcaseBatchRequestSchema, BriefcaseEvents, type ICaller } from '@bike4mind/common';
import { logEvent } from '@server/utils/analyticsLog';
import { Request } from 'express';

const toCaller = (req: Request): ICaller => ({
  id: req.user.id,
  entitlements: req.user.tags ?? [],
  isAdmin: !!req.user.isAdmin,
  isApiKey: !!req.apiKeyInfo,
});

/**
 * POST /api/briefcase/catalog - batched, all-or-nothing catalog fetch.
 * Body: { queries: [{ key, tags? | type? | personal? }] } (bounded, unique keys).
 * Returns: { catalog: { key -> prompt[] } } (metadata only; promptText excluded).
 *
 * The read gate + visibility scoping + personal caller-scoping all live in the
 * service. Personal sub-queries return nothing for API-key callers.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableBriefcase'))
  .use(rateLimit({ limit: 30, windowMs: 60 * 1000 }))
  .post(csrfProtection(), async (req, res) => {
    const parsed = BriefcaseBatchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid batch request', details: parsed.error.flatten() });
    }

    const caller = toCaller(req);
    const catalog = await briefcaseService.getCatalog(parsed.data.queries, caller, {
      db: { briefcasePrompts: briefcasePromptRepository },
    });

    // Audit personal-prompt reads (ids/counts only, never content/PII).
    const personalKeys = parsed.data.queries.filter(q => q.personal).map(q => q.key);
    if (personalKeys.length > 0 && !caller.isApiKey) {
      const resultCount = personalKeys.reduce((n, k) => n + (catalog[k]?.length ?? 0), 0);
      logEvent({
        userId: caller.id,
        type: BriefcaseEvents.PERSONAL_READ,
        metadata: { ownerId: caller.id, resultCount },
      }).catch(() => {});
    }

    return res.json({ catalog });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

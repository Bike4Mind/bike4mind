// apps/client/pages/api/skills/market/suggest-tags.ts
import { z } from 'zod';
import { baseApi } from '@client/server/middlewares/baseApi';
import { skillRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';
import { toSnapshot } from '@bike4mind/server-utils/skillMarket/market';
import { getOperationsClassifierLlm } from '@server/skillMarket/classifySkill';
import { suggestListingTags } from '@server/skillMarket/suggestTags';

const bodySchema = z.object({ skillId: z.string().min(1) });

const HOUR_MS = 60 * 60 * 1000;

/**
 * POST /api/skills/market/suggest-tags - AI tag suggestions for a skill the caller owns, to prefill
 * the publish dialog. Best-effort: any failure past the ownership check is `{ tags: [] }`. Has its
 * own rate-limit bucket so suggestions never spend the publish/scan budget.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(
    rateLimit({
      limit: async req =>
        (await resolveUserRateLimitPerMin(req.user, req)) > 0 ? (req.user?.isAdmin ? Infinity : 30) : 0,
      windowMs: HOUR_MS,
      bucket: 'skill-market-suggest-tags',
    })
  )
  .post(async (req, res) => {
    const user = req.user!;
    const { skillId } = bodySchema.parse(req.body);

    const skill = await skillRepository.findById(skillId);
    // Same ownership rule as publish.
    if (!skill || skill.userId !== user.id) throw new NotFoundError('Skill not found');
    // Publish rejects imported skills, so there is nothing to tag.
    if (skill.importedFrom) return res.json({ tags: [] });

    let tags: string[] = [];
    try {
      const llm = await getOperationsClassifierLlm(req.logger, user.id, { maxTokens: 500 });
      tags = await suggestListingTags(toSnapshot(skill), llm);
    } catch (error) {
      req.logger.warn('[skill-market] tag suggestion failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    res.json({ tags });
  });

export default handler;

// apps/client/pages/api/skills/market/suggest-tags.ts
import { z } from 'zod';
import { baseApi } from '@client/server/middlewares/baseApi';
import { skillRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/common';
import { rateLimit } from '@server/middlewares/rateLimit';
import { toSnapshot } from '@server/skillMarket/market';
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
      limit: req => (req.user?.isAdmin ? Infinity : 30),
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

    let tags: string[] = [];
    try {
      const llm = await getOperationsClassifierLlm(req.logger, user.id, { maxTokens: 200 });
      tags = await suggestListingTags(toSnapshot(skill), llm);
    } catch (error) {
      req.logger.warn('[skill-market] tag suggestion failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    res.json({ tags });
  });

export default handler;

import { questMasterPlanRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { verifyQuestPlanWriteAccess, QUEST_ID_PATTERN } from '@server/utils/questMasterPlanAccess';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

const postRateLimit = rateLimit({ limit: 30, windowMs: 60000 });

const ReviewGateSchema = z.object({
  questId: z.string().min(1).max(100).regex(QUEST_ID_PATTERN, 'Invalid questId format'),
  subQuestId: z.string().min(1).max(100).regex(QUEST_ID_PATTERN, 'Invalid subQuestId format'),
  reviewStatus: z.enum(['pending', 'approved', 'rejected']),
  reviewNote: z.string().max(2000).optional(),
});

const handler = baseApi()
  .use(requireFeatureEnabled('EnableQuestMaster'))
  .post<NextApiRequest, NextApiResponse>(csrfProtection(), postRateLimit, async (req, res) => {
    const planId = req.query.id as string;
    const plan = await verifyQuestPlanWriteAccess(req.user?.id, planId);

    const { questId, subQuestId, reviewStatus, reviewNote } = ReviewGateSchema.parse(req.body);

    const quest = plan.quests.find(q => q.id === questId);
    const subQuest = quest?.subQuests.find(sq => sq.id === subQuestId);
    if (!quest || !subQuest) {
      throw new BadRequestError('Invalid quest or sub-quest ID');
    }

    const updatedPlan = await questMasterPlanRepository.updateReviewGate(
      planId,
      questId,
      subQuestId,
      reviewStatus,
      reviewNote
    );

    res.json({ success: true, plan: updatedPlan });
  });

export default handler;

import { questMasterPlanRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { verifyQuestPlanWriteAccess, QUEST_ID_PATTERN } from '@server/utils/questMasterPlanAccess';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

const postRateLimit = rateLimit({ limit: 50, windowMs: 60000 });

const SubquestProgressSchema = z.object({
  questId: z.string().min(1).max(100).regex(QUEST_ID_PATTERN, 'Invalid questId format'),
  subQuestId: z.string().min(1).max(100).regex(QUEST_ID_PATTERN, 'Invalid subQuestId format'),
  status: z.enum(['not_started', 'in_progress', 'completed', 'skipped', 'deleted']).optional(),
  evidence: z.string().max(5000).optional(),
  timeSpent: z.number().min(0).optional(),
});

const handler = baseApi().post<NextApiRequest, NextApiResponse>(postRateLimit, async (req, res) => {
  const planId = req.query.id as string;
  const plan = await verifyQuestPlanWriteAccess(req.user?.id, planId);

  const { questId, subQuestId, status, evidence, timeSpent } = SubquestProgressSchema.parse(req.body);

  const quest = plan.quests.find(q => q.id === questId);
  const subQuest = quest?.subQuests.find(sq => sq.id === subQuestId);
  if (!quest || !subQuest) {
    throw new BadRequestError('Invalid quest or sub-quest ID');
  }

  const updatedPlan = await questMasterPlanRepository.updateQuestProgress(
    planId,
    questId,
    subQuestId,
    { status, evidence, timeSpent },
    { autoResumeIfPaused: status === 'in_progress' }
  );

  res.json({ success: true, plan: updatedPlan, metrics: updatedPlan?.metrics });
});

export default handler;

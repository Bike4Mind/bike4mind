import { questMasterPlanRepository } from '@bike4mind/database';
import { QuestDecision } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { verifyQuestPlanWriteAccess, QUEST_ID_PATTERN } from '@server/utils/questMasterPlanAccess';
import { NextApiRequest, NextApiResponse } from 'next';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

const postRateLimit = rateLimit({ limit: 30, windowMs: 60000 });

const AddDecisionSchema = z.object({
  description: z.string().min(1).max(2000),
  rationale: z.string().min(1).max(5000),
  madeBy: z.string().min(1).max(200),
  relatedQuestId: z.string().min(1).max(100).regex(QUEST_ID_PATTERN, 'Invalid questId format').optional(),
  relatedSubQuestId: z.string().min(1).max(100).regex(QUEST_ID_PATTERN, 'Invalid subQuestId format').optional(),
});

const handler = baseApi().post<NextApiRequest, NextApiResponse>(postRateLimit, async (req, res) => {
  const planId = req.query.id as string;
  await verifyQuestPlanWriteAccess(req.user?.id, planId);

  const body = AddDecisionSchema.parse(req.body);

  const decision: QuestDecision = {
    id: uuidv4(),
    ...body,
    madeAt: new Date(),
  };

  const updatedPlan = await questMasterPlanRepository.addDecision(planId, decision);

  res.json({ success: true, plan: updatedPlan, decisionId: decision.id });
});

export default handler;

import { questMasterPlanRepository } from '@bike4mind/database';
import { QuestHandoff } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { verifyQuestPlanWriteAccess } from '@server/utils/questMasterPlanAccess';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

const postRateLimit = rateLimit({ limit: 30, windowMs: 60000 });

const HandoffSchema = z.object({
  summary: z.string().min(1).max(5000),
  nextSteps: z.array(z.string().min(1).max(1000)).max(50),
  pendingDecisions: z.array(z.string().min(1).max(1000)).max(50),
  blockers: z.array(z.string().min(1).max(1000)).max(50),
});

const handler = baseApi().post<NextApiRequest, NextApiResponse>(postRateLimit, async (req, res) => {
  const planId = req.query.id as string;
  await verifyQuestPlanWriteAccess(req.user?.id, planId);

  const body = HandoffSchema.parse(req.body);

  const handoff: QuestHandoff = {
    ...body,
    lastUpdatedBy: req.user!.id,
    updatedAt: new Date(),
  };

  const updatedPlan = await questMasterPlanRepository.updateHandoff(planId, handoff);

  res.json({ success: true, plan: updatedPlan });
});

export default handler;

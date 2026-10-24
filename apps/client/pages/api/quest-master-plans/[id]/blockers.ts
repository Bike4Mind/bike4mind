import { questMasterPlanRepository } from '@bike4mind/database';
import { NotFoundError, QuestBlocker, questMasterPlanMutationResponseSchema } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { respond } from '@server/utils/respond';
import { verifyQuestPlanWriteAccess, QUEST_ID_PATTERN } from '@server/utils/questMasterPlanAccess';
import { NextApiRequest, NextApiResponse } from 'next';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

const postRateLimit = rateLimit({ limit: 30, windowMs: 60000 });

const AddBlockerSchema = z.object({
  description: z.string().min(1).max(2000),
  relatedQuestId: z.string().min(1).max(100).regex(QUEST_ID_PATTERN, 'Invalid questId format').optional(),
  relatedSubQuestId: z.string().min(1).max(100).regex(QUEST_ID_PATTERN, 'Invalid subQuestId format').optional(),
});

const blockerResponseSchema = questMasterPlanMutationResponseSchema.extend({ blockerId: z.string() });

const handler = baseApi()
  .use(requireFeatureEnabled('EnableQuestMaster'))
  .post<NextApiRequest, NextApiResponse>(csrfProtection(), postRateLimit, async (req, res) => {
    const planId = req.query.id as string;
    await verifyQuestPlanWriteAccess(req.user?.id, planId);

    const body = AddBlockerSchema.parse(req.body);

    const blocker: QuestBlocker = {
      id: uuidv4(),
      ...body,
      createdAt: new Date(),
    };

    const updatedPlan = await questMasterPlanRepository.addBlocker(planId, req.user!.id, blocker);

    if (!updatedPlan) throw new NotFoundError('Quest plan not found');

    respond(res, blockerResponseSchema, { success: true, plan: updatedPlan, blockerId: blocker.id });
  });

export default handler;

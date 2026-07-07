import { questMasterPlanRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { verifyQuestPlanWriteAccess } from '@server/utils/questMasterPlanAccess';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

const postRateLimit = rateLimit({ limit: 30, windowMs: 60000 });

const ResolveBlockerSchema = z.object({
  blockerId: z.string().min(1).max(100),
  resolution: z.string().min(1).max(2000),
});

const handler = baseApi()
  .use(requireFeatureEnabled('EnableQuestMaster'))
  .post<NextApiRequest, NextApiResponse>(csrfProtection(), postRateLimit, async (req, res) => {
    const planId = req.query.id as string;
    const plan = await verifyQuestPlanWriteAccess(req.user?.id, planId);

    const { blockerId, resolution } = ResolveBlockerSchema.parse(req.body);

    const blockerExists = plan.blockers?.some(b => b.id === blockerId);
    if (!blockerExists) {
      throw new NotFoundError('Blocker not found');
    }

    const updatedPlan = await questMasterPlanRepository.resolveBlocker(planId, blockerId, resolution);

    if (!updatedPlan) {
      throw new NotFoundError('Blocker not found or already resolved');
    }

    res.json({ success: true, plan: updatedPlan });
  });

export default handler;

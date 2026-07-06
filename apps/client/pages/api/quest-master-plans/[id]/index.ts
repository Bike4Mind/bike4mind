import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { verifyQuestPlanReadAccess } from '@server/utils/questMasterPlanAccess';
import { Request } from 'express';

const getRateLimit = rateLimit({ limit: 100, windowMs: 60000 });

const handler = baseApi()
  .use(requireFeatureEnabled('EnableQuestMaster'))
  .get(getRateLimit, async (req: Request<unknown, unknown, unknown, { id: string }>, res) => {
    const { id } = req.query;

    const questMasterPlan = await verifyQuestPlanReadAccess(req.user?.id, id);

    return res.status(200).json(questMasterPlan);
  });

export default handler;

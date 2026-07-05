import { questMasterPlanRepository, sessionRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { Request } from 'express';
import { Types } from 'mongoose';

const isValidObjectId = (id: string): boolean => {
  return Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;
};

const getRateLimit = rateLimit({ limit: 100, windowMs: 60000 });

const handler = baseApi().get(getRateLimit, async (req: Request<unknown, unknown, unknown, { id: string }>, res) => {
  const userId = req.user?.id;
  const { id } = req.query;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: 'Invalid plan ID format' });
  }

  const questMasterPlan = await questMasterPlanRepository.findById(id);

  if (!questMasterPlan) {
    return res.status(404).json({ error: 'Quest plan not found' });
  }

  let hasAccess = false;

  if (questMasterPlan.userId) {
    // New plans with userId field
    hasAccess =
      questMasterPlan.userId === userId ||
      questMasterPlan.sharedWith?.includes(userId) ||
      questMasterPlan.visibility === 'public';
  } else {
    // Legacy plans without userId - check session ownership
    const session = await sessionRepository.findById(questMasterPlan.notebookId);
    hasAccess = Boolean(session && session.userId === userId);

    // Backfill userId for this legacy plan
    if (hasAccess && session) {
      questMasterPlan.userId = session.userId;
      await questMasterPlanRepository.update(questMasterPlan);
    }
  }

  if (!hasAccess) {
    return res.status(403).json({ error: 'Access denied' });
  }

  return res.status(200).json(questMasterPlan);
});

export default handler;

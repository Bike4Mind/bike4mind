import { questMasterPlanRepository, sessionRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { Request } from 'express';
import { toObjectIdString } from '@server/utils/objectId';

const handler = baseApi().get<Request<unknown, unknown, unknown, { id: string }>>(async (req, res) => {
  const userId = req.user?.id;
  const { id } = req.query;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Canonicalized: the session lookup casts and so matches any casing, but
  // findByNotebookId hits `notebookId: { type: String }` (QuestMasterPlanModel), which
  // does byte equality - an uppercase id would return an empty list instead of the plans.
  const sessionId = toObjectIdString(id);
  if (!sessionId) {
    return res.status(400).json({ error: 'Invalid session ID format' });
  }

  const session = await sessionRepository.findById(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.userId !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const questMasterPlans = await questMasterPlanRepository.findByNotebookId(sessionId);
  return res.json(questMasterPlans);
});

export default handler;

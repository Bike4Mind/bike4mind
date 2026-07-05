import { questMasterPlanRepository, sessionRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { Request } from 'express';
import { Types } from 'mongoose';

const isValidObjectId = (id: string): boolean => {
  return Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;
};

const handler = baseApi().get<Request<unknown, unknown, unknown, { id: string }>>(async (req, res) => {
  const userId = req.user?.id;
  const { id } = req.query;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: 'Invalid session ID format' });
  }

  const session = await sessionRepository.findById(id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.userId !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const questMasterPlans = await questMasterPlanRepository.findByNotebookId(id);
  return res.json(questMasterPlans);
});

export default handler;

import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { MementoGroomingService, MEMORY_LIMITS } from '../../../services/MementoGroomingService';

const handler = baseApi().post(async (req: Request, res: Response) => {
  req.logger.updateMetadata({ endpoint: 'mementos/groom' });
  const groomingService = new MementoGroomingService(req.logger);

  try {
    const userId = req.user.id;

    // Get user-specific maxTotalChars setting if it exists
    const maxTotalChars = MEMORY_LIMITS.DEFAULT_MAX_TOTAL_CHARS;

    await groomingService.checkAndScheduleGrooming(userId, maxTotalChars);

    return res.status(200).json({
      message: 'Memento grooming scheduled successfully',
      maxTotalChars,
    });
  } catch (error) {
    req.logger.error('Error scheduling memento grooming:', error);
    return res.status(500).json({ error: 'Failed to schedule memento grooming' });
  }
});

export default handler;

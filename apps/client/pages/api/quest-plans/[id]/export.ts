import { questMasterPlanRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { sendToQueue } from '@server/utils/sqs';
import { NextApiRequest, NextApiResponse } from 'next';
import { Types } from 'mongoose';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '@bike4mind/observability';

const isValidObjectId = (id: string): boolean => {
  return Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;
};

const exportRateLimit = rateLimit({ limit: 5, windowMs: 60000 });

const handler = baseApi()
  .use(requireFeatureEnabled('EnableQuestMaster'))
  .post<NextApiRequest, NextApiResponse>(exportRateLimit, async (req, res) => {
    const userId = req.user?.id;
    const planId = req.query.id as string;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!isValidObjectId(planId)) {
      return res.status(400).json({ error: 'Invalid plan ID format' });
    }

    // Verify plan exists and user has access
    const plan = await questMasterPlanRepository.findById(planId);
    if (!plan) {
      return res.status(404).json({ error: 'Quest plan not found' });
    }

    if (plan.userId !== userId && !plan.sharedWith?.includes(userId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const exportJobId = uuidv4();

    Logger.info('[Quest Export] Starting export', { planId, exportJobId, userId });

    try {
      const queueUrl = getSourceQueueUrl('questExportQueue');
      await sendToQueue(queueUrl, {
        exportJobId,
        planId,
        userId,
      });

      Logger.info('[Quest Export] Message sent to queue', { exportJobId, planId });
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      Logger.error('[Quest Export] Failed to queue job', { exportJobId, error: errorMsg });
      return res.status(500).json({ error: 'Failed to start export. Please try again.' });
    }

    return res.status(202).json({
      success: true,
      exportJobId,
      planId,
    });
  });

export default handler;

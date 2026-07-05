import { questMasterPlanRepository, sessionRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { NextApiRequest, NextApiResponse } from 'next';
import { Types } from 'mongoose';
import { z } from 'zod';

const isValidObjectId = (id: string): boolean => {
  return Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;
};

const progressRateLimit = rateLimit({ limit: 50, windowMs: 60000 });

// Regex pattern for valid ID strings (alphanumeric, hyphens, underscores, dots)
// Dots added for backward compatibility with LLM-generated IDs like "setup.1"
const ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

const UpdateProgressSchema = z.object({
  questId: z.string().min(1).max(100).regex(ID_PATTERN, 'Invalid questId format'),
  subQuestId: z.string().min(1).max(100).regex(ID_PATTERN, 'Invalid subQuestId format'),
  status: z.enum(['not_started', 'in_progress', 'completed', 'skipped', 'deleted']).optional(),
  timeSpent: z.number().min(0).optional(),
  chatMessageId: z.string().max(100).regex(ID_PATTERN, 'Invalid chatMessageId format').optional(),
  startedAt: z.number().optional(),
});

const handler = baseApi()
  .use(requireFeatureEnabled('EnableQuestMaster'))
  .patch<NextApiRequest, NextApiResponse>(csrfProtection(), progressRateLimit, async (req, res) => {
    try {
      const userId = req.user?.id;
      const planId = req.query.id as string;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!isValidObjectId(planId)) {
        return res.status(400).json({ error: 'Invalid plan ID format' });
      }

      const bodyResult = UpdateProgressSchema.safeParse(req.body);
      if (!bodyResult.success) {
        return res.status(400).json({ error: 'Invalid input', details: z.treeifyError(bodyResult.error) });
      }
      const { questId, subQuestId, status, timeSpent, chatMessageId, startedAt } = bodyResult.data;

      const plan = await questMasterPlanRepository.findById(planId);

      if (!plan) {
        return res.status(404).json({ error: 'Quest plan not found' });
      }

      // Check access - user can update progress if they own it or it's explicitly shared
      // Public plans are read-only and cannot have progress updated by non-owners
      let hasAccess = false;
      let isOwner = false;

      if (plan.userId) {
        // New plans with userId field
        isOwner = plan.userId === userId;
        hasAccess = isOwner || (plan.sharedWith?.includes(userId) ?? false);
      } else {
        // Legacy plans without userId - check session ownership
        // Validate that notebookId is a valid MongoDB ObjectId before querying
        if (!isValidObjectId(plan.notebookId)) {
          return res.status(403).json({ error: 'Access denied' });
        }

        const session = await sessionRepository.findById(plan.notebookId);

        if (!session) {
          return res.status(403).json({ error: 'Access denied' });
        }

        isOwner = session.userId === userId;
        hasAccess = isOwner;

        // Only backfill userId if user actually owns the session
        // This prevents unauthorized users from claiming orphaned plans
        if (isOwner) {
          plan.userId = session.userId;
          await questMasterPlanRepository.update(plan);
        }
      }

      if (!hasAccess) {
        // Use consistent error message to avoid leaking visibility information
        return res.status(403).json({ error: 'Access denied' });
      }

      const quest = plan.quests.find(q => q.id === questId);
      const subQuest = quest?.subQuests.find(sq => sq.id === subQuestId);
      if (!quest || !subQuest) {
        return res.status(400).json({ error: 'Invalid quest or sub-quest ID' });
      }

      // Update progress (auto-resume is handled atomically in the repository)
      // Returns the updated plan with fresh metrics, avoiding a second fetch
      const updatedPlan = await questMasterPlanRepository.updateQuestProgress(
        planId,
        questId,
        subQuestId,
        {
          status,
          timeSpent,
          chatMessageId,
          startedAt,
        },
        {
          // Auto-resume paused quests when starting work on a subtask
          autoResumeIfPaused: status === 'in_progress',
        }
      );

      res.json({
        success: true,
        plan: updatedPlan,
        metrics: updatedPlan?.metrics,
      });
    } catch (error: unknown) {
      console.error('Error updating quest progress:', error);
      // Return generic error to prevent information leakage
      res.status(500).json({ error: 'Failed to update quest progress' });
    }
  });

export default handler;

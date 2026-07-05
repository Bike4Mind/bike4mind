import { questMasterPlanRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { NextApiRequest, NextApiResponse } from 'next';
import { Types } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

const isValidObjectId = (id: string): boolean => {
  return Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;
};

// Regex for safe goal suffix characters (alphanumeric, spaces, punctuation, no control chars)
const SAFE_GOAL_SUFFIX_PATTERN = /^[\w\s\-.,!?()[\]'"@#$%&*+=/:\\;]+$/;

const CloneRequestSchema = z.strictObject({
  // Optional goal-name override; regex blocks control chars and CRLF injection.
  goalSuffix: z
    .string()
    .max(100)
    .regex(
      SAFE_GOAL_SUFFIX_PATTERN,
      'Goal suffix can only contain alphanumeric characters, spaces, and common punctuation'
    )
    .optional(),
});

// Rate limit: 5 clones per minute per user (prevents storage bloat)
const cloneRateLimit = rateLimit({ limit: 5, windowMs: 60000 });

const handler = baseApi()
  .use(requireFeatureEnabled('EnableQuestMaster'))
  .post<NextApiRequest, NextApiResponse>(csrfProtection(), cloneRateLimit, async (req, res) => {
    try {
      const userId = req.user?.id;
      const planId = req.query.id as string;

      const bodyResult = CloneRequestSchema.safeParse(req.body || {});
      if (!bodyResult.success) {
        return res.status(400).json({ error: 'Invalid request body', details: z.treeifyError(bodyResult.error) });
      }
      const { goalSuffix } = bodyResult.data;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!isValidObjectId(planId)) {
        return res.status(400).json({ error: 'Invalid plan ID format' });
      }

      const originalPlan = await questMasterPlanRepository.findById(planId);

      if (!originalPlan) {
        return res.status(404).json({ error: 'Quest plan not found' });
      }

      // Check access - user can clone if they own it or it's explicitly shared with them
      // Public plans are read-only and cannot be cloned by non-owners
      const isOwner = originalPlan.userId === userId;
      const isShared = originalPlan.sharedWith?.includes(userId) ?? false;

      if (!isOwner && !isShared) {
        // Use consistent error message to avoid leaking visibility information
        return res.status(403).json({ error: 'Access denied' });
      }

      // No depth limit on clone chains: parentPlanId tracks only the immediate parent,
      // not the full lineage. Cloning a clone is allowed by design.

      // Create the cloned plan with reset statuses
      const clonedPlan = await questMasterPlanRepository.create({
        notebookId: `clone-${uuidv4()}`,
        userId,
        goal: `${originalPlan.goal}${goalSuffix || ' (Copy)'}`,
        quests: originalPlan.quests.map(quest => ({
          id: uuidv4(),
          title: quest.title,
          description: quest.description,
          complexity: quest.complexity,
          subQuests: quest.subQuests.map(sq => ({
            id: uuidv4(),
            title: sq.title,
            status: 'not_started',
            // Clear any linked chat message IDs
            questId: undefined,
          })),
        })),
        state: 'active',
        visibility: 'user',
        parentPlanId: originalPlan.id,
        tags: originalPlan.tags ? [...originalPlan.tags] : [],
        priority: originalPlan.priority,
        metrics: {
          totalTimeSpent: 0,
          completionRate: 0,
          subQuestsCompleted: 0,
          subQuestsTotal: originalPlan.quests.reduce((acc, q) => acc + q.subQuests.length, 0),
        },
      });

      res.status(201).json({
        success: true,
        plan: clonedPlan,
      });
    } catch (error) {
      console.error('Error cloning quest plan:', error);
      res.status(500).json({ error: 'Failed to clone quest plan' });
    }
  });

export default handler;

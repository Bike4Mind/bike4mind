import { questMasterPlanRepository, userRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { NextApiRequest, NextApiResponse } from 'next';
import { Types } from 'mongoose';
import { z } from 'zod';

const MAX_SHARED_WITH_USERS = 50;

const isValidObjectId = (id: string): boolean => {
  return Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;
};

// Regex for safe tag characters (alphanumeric, spaces, hyphens, underscores)
const SAFE_TAG_PATTERN = /^[a-zA-Z0-9\s\-_]+$/;

const UpdateQuestPlanSchema = z.object({
  goal: z.string().min(1).max(2000).optional(),
  state: z.enum(['draft', 'active', 'paused', 'completed', 'archived']).optional(),
  visibility: z.enum(['session', 'user', 'team', 'public']).optional(),
  tags: z
    .array(
      z
        .string()
        .max(50)
        .regex(SAFE_TAG_PATTERN, 'Tags can only contain alphanumeric characters, spaces, hyphens, and underscores')
    )
    .max(20)
    .optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  // Limit sharedWith array size to prevent abuse
  sharedWith: z.array(z.string()).max(MAX_SHARED_WITH_USERS).optional(),
});

const getRateLimit = rateLimit({ limit: 100, windowMs: 60000 });
const updateRateLimit = rateLimit({ limit: 30, windowMs: 60000 });
const deleteRateLimit = rateLimit({ limit: 10, windowMs: 60000 });

const handler = baseApi()
  .use(requireFeatureEnabled('EnableQuestMaster'))
  .get<NextApiRequest, NextApiResponse>(getRateLimit, async (req, res) => {
    try {
      const userId = req.user?.id;
      const planId = req.query.id as string;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Validate planId format to prevent invalid database queries
      if (!isValidObjectId(planId)) {
        return res.status(400).json({ error: 'Invalid plan ID format' });
      }

      const plan = await questMasterPlanRepository.findById(planId);

      if (!plan) {
        return res.status(404).json({ error: 'Quest plan not found' });
      }

      if (plan.userId !== userId && !plan.sharedWith?.includes(userId) && plan.visibility !== 'public') {
        return res.status(403).json({ error: 'Access denied' });
      }

      plan.lastAccessedAt = new Date();
      await questMasterPlanRepository.update(plan);

      res.json(plan);
    } catch (error) {
      console.error('Error fetching quest plan:', error);
      res.status(500).json({ error: 'Failed to fetch quest plan' });
    }
  })
  .patch<NextApiRequest, NextApiResponse>(csrfProtection(), updateRateLimit, async (req, res) => {
    try {
      const userId = req.user?.id;
      const planId = req.query.id as string;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Validate planId format to prevent invalid database queries
      if (!isValidObjectId(planId)) {
        return res.status(400).json({ error: 'Invalid plan ID format' });
      }

      const plan = await questMasterPlanRepository.findById(planId);

      if (!plan) {
        return res.status(404).json({ error: 'Quest plan not found' });
      }

      // Only owner can update (for now)
      if (plan.userId !== userId) {
        return res.status(403).json({ error: 'Only owner can update quest plan' });
      }

      const bodyResult = UpdateQuestPlanSchema.safeParse(req.body);
      if (!bodyResult.success) {
        return res.status(400).json({ error: 'Invalid input', details: z.treeifyError(bodyResult.error) });
      }
      const { goal, state, visibility, tags, priority, sharedWith } = bodyResult.data;

      // Validate sharedWith user IDs if provided (batch query to avoid N+1)
      if (sharedWith !== undefined && sharedWith.length > 0) {
        const invalidFormatIds = sharedWith.filter(uid => !isValidObjectId(uid));
        if (invalidFormatIds.length > 0) {
          return res.status(400).json({
            error: 'One or more user IDs in sharedWith have invalid format',
          });
        }

        const validUsers = await userRepository.findByIds(sharedWith);
        const validUserIds = new Set(validUsers.map(u => u.id));
        const hasInvalidUsers = sharedWith.some(uid => !validUserIds.has(uid));
        if (hasInvalidUsers) {
          // Rate limiting, not a constant-time delay, is the defense against user enumeration
          // here: network latency (10-500ms) already dwarfs any artificial delay we could add.
          return res.status(400).json({
            error: 'One or more user IDs in sharedWith are invalid',
          });
        }
      }

      if (goal !== undefined) plan.goal = goal;
      if (state !== undefined) {
        const currentState = plan.state || 'active';
        if (!questMasterPlanRepository.isValidStateTransition(currentState, state)) {
          return res.status(400).json({
            error: `Invalid state transition from '${currentState}' to '${state}'`,
          });
        }
        plan.state = state;
      }
      if (visibility !== undefined) plan.visibility = visibility;
      if (tags !== undefined) plan.tags = tags;
      if (priority !== undefined) plan.priority = priority;
      if (sharedWith !== undefined) plan.sharedWith = sharedWith;

      plan.lastAccessedAt = new Date();

      const updated = await questMasterPlanRepository.update(plan);
      res.json(updated);
    } catch (error) {
      console.error('Error updating quest plan:', error);
      res.status(500).json({ error: 'Failed to update quest plan' });
    }
  })
  .delete<NextApiRequest, NextApiResponse>(csrfProtection(), deleteRateLimit, async (req, res) => {
    try {
      const userId = req.user?.id;
      const planId = req.query.id as string;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Validate planId format to prevent invalid database queries
      if (!isValidObjectId(planId)) {
        return res.status(400).json({ error: 'Invalid plan ID format' });
      }

      const plan = await questMasterPlanRepository.findById(planId);

      if (!plan) {
        return res.status(404).json({ error: 'Quest plan not found' });
      }

      if (plan.userId !== userId) {
        return res.status(403).json({ error: 'Only owner can archive quest plan' });
      }

      // Soft delete by archiving
      plan.state = 'archived';
      await questMasterPlanRepository.update(plan);

      res.status(204).end();
    } catch (error) {
      console.error('Error archiving quest plan:', error);
      res.status(500).json({ error: 'Failed to archive quest plan' });
    }
  });

export default handler;

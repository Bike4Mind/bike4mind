import {
  questMasterPlanRepository,
  questRepository,
  sessionRepository,
  projectRepository,
  fabFileRepository,
} from '@bike4mind/database';
import { sessionService } from '@bike4mind/services';
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

const ContinueRequestSchema = z.object({
  sessionId: z.string().refine(isValidObjectId, {
    error: 'Invalid sessionId format',
  }),
});

const continueRateLimit = rateLimit({ limit: 20, windowMs: 60000 });

const handler = baseApi()
  .use(requireFeatureEnabled('EnableQuestMaster'))
  .post<NextApiRequest, NextApiResponse>(csrfProtection(), continueRateLimit, async (req, res) => {
    try {
      const userId = req.user?.id;
      const planId = req.query.id as string;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!isValidObjectId(planId)) {
        return res.status(400).json({ error: 'Invalid plan ID format' });
      }

      const bodyResult = ContinueRequestSchema.safeParse(req.body);
      if (!bodyResult.success) {
        return res.status(400).json({ error: 'Invalid input', details: z.treeifyError(bodyResult.error) });
      }
      const { sessionId } = bodyResult.data;

      const session = await sessionRepository.findById(sessionId);
      if (!session || session.userId !== userId) {
        return res.status(403).json({ error: 'Invalid session' });
      }

      const existingPlan = await questMasterPlanRepository.findById(planId);
      if (!existingPlan) {
        return res.status(404).json({ error: 'Quest plan not found' });
      }

      // Check access - user can continue if they own it or it's explicitly shared with them
      // Public plans are read-only and cannot be continued by non-owners
      const isOwner = existingPlan.userId === userId;
      const isShared = existingPlan.sharedWith?.includes(userId) ?? false;

      if (!isOwner && !isShared) {
        // Use consistent error message to avoid leaking visibility information
        return res.status(403).json({ error: 'Access denied' });
      }

      // Check if notebookId is a placeholder (from clone or direct creation)
      const isPlaceholder =
        existingPlan.notebookId.startsWith('clone-') || existingPlan.notebookId.startsWith('direct-');

      let actualSessionId = sessionId;

      if (isPlaceholder) {
        // Atomically update notebookId only if it still holds the placeholder,
        // so only one request creates the session.
        const goalPreview = existingPlan.goal.length > 50 ? `${existingPlan.goal.slice(0, 50)}...` : existingPlan.goal;
        const newSession = await sessionService.createSession(
          req.user,
          { name: `Quest: ${goalPreview}` },
          {
            db: {
              sessions: sessionRepository,
              projects: projectRepository,
              fabFiles: fabFileRepository,
            },
          }
        );

        // Skip if notebookId already changed by a concurrent request
        const updateResult = await questMasterPlanRepository.atomicUpdateNotebookId(
          planId,
          existingPlan.notebookId, // expected current value (placeholder)
          newSession.id // new value
        );

        if (updateResult) {
          actualSessionId = newSession.id;
        } else {
          // Another request already updated it - fetch the current notebookId
          const refreshedPlan = await questMasterPlanRepository.findById(planId);
          if (refreshedPlan) {
            actualSessionId = refreshedPlan.notebookId;
          }
          // Clean up the orphaned session; rare race, but avoids a resource leak.
          try {
            await sessionRepository.delete(newSession.id);
            console.log(`Cleaned up orphaned session ${newSession.id} after race condition`);
          } catch (cleanupError) {
            // Log but don't fail the request - the main operation succeeded
            console.warn(`Failed to clean up orphaned session ${newSession.id}:`, cleanupError);
          }
        }
      }

      // Auto-resume if paused
      if (existingPlan.state === 'paused') {
        existingPlan.state = 'active';
        await questMasterPlanRepository.update(existingPlan);
      }

      const plan = await questMasterPlanRepository.continueInSession(planId, actualSessionId, userId);

      const contextMessage = await questRepository.create({
        sessionId: actualSessionId,
        type: 'system',
        prompt: `Continuing quest: "${plan.goal}"\n\nProgress: ${plan.metrics?.completionRate || 0}% complete (${plan.metrics?.subQuestsCompleted || 0}/${plan.metrics?.subQuestsTotal || 0} tasks done)`,
        questMasterPlanId: plan.id,
        timestamp: new Date(),
        status: 'done',
      });

      res.json({
        success: true,
        plan,
        sessionId: actualSessionId,
        contextMessage: {
          id: contextMessage.id,
          prompt: contextMessage.prompt,
        },
      });
    } catch (error: unknown) {
      console.error('Error continuing quest plan:', error);
      // Return generic error to prevent information leakage
      res.status(500).json({ error: 'Failed to continue quest plan' });
    }
  });

export default handler;

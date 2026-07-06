import { questMasterPlanRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { verifyQuestPlanWriteAccess } from '@server/utils/questMasterPlanAccess';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

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
    const planId = req.query.id as string;

    const bodyResult = UpdateProgressSchema.safeParse(req.body);
    if (!bodyResult.success) {
      return res.status(400).json({ error: 'Invalid input', details: z.treeifyError(bodyResult.error) });
    }
    const { questId, subQuestId, status, timeSpent, chatMessageId, startedAt } = bodyResult.data;

    // Owner or shared collaborator; public plans are read-only. Legacy plans
    // without userId are backfilled from session ownership inside the util.
    const plan = await verifyQuestPlanWriteAccess(req.user?.id, planId);

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
  });

export default handler;

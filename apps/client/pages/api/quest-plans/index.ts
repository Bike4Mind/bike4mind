import { questMasterPlanRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { NextApiRequest, NextApiResponse } from 'next';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

// Quest plan state constants
export const QUEST_PLAN_STATES = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  ARCHIVED: 'archived',
} as const;

export const QUEST_PLAN_VISIBILITY = {
  SESSION: 'session',
  USER: 'user',
  TEAM: 'team',
  PUBLIC: 'public',
} as const;

export const QUEST_PLAN_PRIORITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const;

const QuestPlansQuerySchema = z.object({
  state: z.enum(['draft', 'active', 'paused', 'completed', 'archived']).optional(),
  tags: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).prefault(50),
  offset: z.coerce.number().min(0).prefault(0),
});

const SubQuestSchema = z.object({
  id: z.string(),
  title: z.string().max(500),
  status: z.enum(['not_started', 'in_progress', 'completed', 'skipped', 'deleted']).prefault('not_started'),
  questId: z.string().optional(),
  startedAt: z.number().optional(),
});

const QuestSchema = z.object({
  id: z.string(),
  title: z.string().max(500),
  description: z.string().max(2000),
  complexity: z.string(),
  subQuests: z.array(SubQuestSchema).max(50),
});

// Regex for safe tag characters (alphanumeric, spaces, hyphens, underscores)
const SAFE_TAG_PATTERN = /^[a-zA-Z0-9\s\-_]+$/;

const CreateQuestPlanSchema = z.object({
  goal: z.string().min(1).max(2000),
  quests: z.array(QuestSchema).max(100).prefault([]),
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
});

const listRateLimit = rateLimit({ limit: 100, windowMs: 60000 });
const createRateLimit = rateLimit({ limit: 10, windowMs: 60000 });

const handler = baseApi()
  .use(requireFeatureEnabled('EnableQuestMaster'))
  .get<NextApiRequest, NextApiResponse>(listRateLimit, async (req, res) => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const queryResult = QuestPlansQuerySchema.safeParse(req.query);
      if (!queryResult.success) {
        return res.status(400).json({ error: 'Invalid query parameters', details: z.treeifyError(queryResult.error) });
      }

      const { state, tags, limit, offset } = queryResult.data;

      const options = {
        state,
        // Split tags and trim whitespace to handle "tag1, tag2" correctly
        tags: tags
          ? tags
              .split(',')
              .map(t => t.trim())
              .filter(Boolean)
          : undefined,
        limit,
        offset,
      };

      // Get user's quest plans with count and stats in efficient parallel queries
      const { plans, total, stats } = await questMasterPlanRepository.findByUserIdWithCount(userId, options);

      res.json({
        data: plans,
        pagination: {
          limit,
          offset,
          total,
          hasMore: total > offset + limit,
        },
        stats,
      });
    } catch (error) {
      console.error('Error fetching quest plans:', error);
      res.status(500).json({ error: 'Failed to fetch quest plans' });
    }
  })
  .post<NextApiRequest, NextApiResponse>(csrfProtection(), createRateLimit, async (req, res) => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const bodyResult = CreateQuestPlanSchema.safeParse(req.body);
      if (!bodyResult.success) {
        return res.status(400).json({ error: 'Invalid input', details: z.treeifyError(bodyResult.error) });
      }
      const { goal, quests, tags, priority } = bodyResult.data;

      // Create new quest plan directly (not from chat)
      const plan = await questMasterPlanRepository.create({
        // Generate a placeholder notebookId with UUID (can be updated when attached to session)
        notebookId: `direct-${uuidv4()}`,
        userId,
        goal,
        quests,
        tags,
        priority,
        visibility: 'user',
        state: 'active',
        lastAccessedAt: new Date(),
        sessionHistory: [],
        metrics: {
          totalTimeSpent: 0,
          completionRate: 0,
          subQuestsCompleted: 0,
          subQuestsTotal: quests.reduce((acc: number, q: any) => acc + (q.subQuests?.length || 0), 0),
        },
      });

      res.status(201).json(plan);
    } catch (error) {
      console.error('Error creating quest plan:', error);
      res.status(500).json({ error: 'Failed to create quest plan' });
    }
  });

export default handler;

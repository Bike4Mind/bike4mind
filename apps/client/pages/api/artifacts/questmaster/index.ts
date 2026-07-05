// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { questMasterService } from '@bike4mind/services';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { questMasterArtifactRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';
import qs from 'qs';

const CreateQuestSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  content: z.string().min(1),
  questType: z.enum(['tutorial', 'challenge', 'exercise', 'project']).prefault('tutorial'),
  complexity: z.enum(['beginner', 'intermediate', 'advanced', 'expert']).prefault('beginner'),
  estimatedDuration: z.number().min(5).max(10080).optional(), // 5 minutes to 1 week
  prerequisites: z.array(z.string()).prefault([]),
  dependencies: z.array(z.string()).prefault([]),
  resources: z
    .object({
      documentation: z.array(z.string()).prefault([]),
      tutorials: z.array(z.string()).prefault([]),
      examples: z.array(z.string()).prefault([]),
    })
    .prefault({}),
  tags: z.array(z.string().max(50)).max(20).prefault([]),
  visibility: z.enum(['private', 'project', 'organization', 'public']).prefault('private'),
  projectId: z.string().optional(),
  organizationId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).prefault({}),
});

const ListQuestsSchema = z.object({
  limit: z.coerce.number().min(1).max(100).prefault(20),
  offset: z.coerce.number().min(0).prefault(0),
  sortBy: z.enum(['title', 'createdAt', 'complexity', 'estimatedDuration']).prefault('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).prefault('desc'),
  questType: z.enum(['tutorial', 'challenge', 'exercise', 'project']).optional(),
  complexity: z.enum(['beginner', 'intermediate', 'advanced', 'expert']).optional(),
  status: z.enum(['not_started', 'in_progress', 'completed', 'blocked']).optional(),
  visibility: z.enum(['private', 'project', 'organization', 'public']).optional(),
  projectId: z.string().optional(),
  tags: z.array(z.string()).prefault([]),
  search: z.string().optional(),
});

const handler = baseApi()
  /**
   * GET /api/artifacts/questmaster
   * List quest artifacts with filtering
   */
  .get(
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const queryParams = qs.parse(req.query as any);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const validatedParams = ListQuestsSchema.parse(queryParams);

      // Placeholder response for now
      const result = { quests: [], pagination: { total: 0, limit: 20, offset: 0, hasMore: false } };
      // TODO: Re-enable when questMasterService.listQuests is implemented
      // const result = await questMasterService.listQuests(userId, validatedParams, {
      //   db: { questMasterArtifacts: questMasterArtifactRepository as any }
      // });

      return res.json(result);
    })
  )
  /**
   * POST /api/artifacts/questmaster
   * Create a new quest artifact
   */
  .post(
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const validatedData = CreateQuestSchema.parse(req.body);

      // Placeholder response for now
      const result = { success: true, message: 'QuestMaster creation not yet implemented' };
      // TODO: Re-enable when questMasterService.create schema is aligned
      // const result = await questMasterService.create(userId, validatedData as any, {
      //   db: { questMasterArtifacts: questMasterArtifactRepository as any }
      // });

      return res.status(201).json(result);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

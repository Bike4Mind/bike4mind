import { artifactService } from '@bike4mind/services';
import { artifactRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';
import qs from 'qs';

const SearchArtifactsSchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().min(1).max(100).prefault(20),
  offset: z.coerce.number().min(0).prefault(0),
  type: z.string().optional(),
  visibility: z.enum(['private', 'project', 'organization', 'public']).optional(),
  projectId: z.string().optional(),
  tags: z.array(z.string()).prefault([]),
});

const handler = baseApi()
  /**
   * GET /api/artifacts/search
   * Search artifacts by text
   */
  .get(
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const queryParams = qs.parse(req.query as any);
      const validatedParams = SearchArtifactsSchema.parse(queryParams);

      // Use the list service with search parameter
      const result = await artifactService.list(
        userId,
        {
          ...validatedParams,
          search: validatedParams.q,
          sortBy: 'createdAt' as const,
          sortOrder: 'desc' as const,
          includeDeleted: false,
        },
        {
          db: {
            artifacts: artifactRepository as any,          },
        }
      );

      return res.json(result);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

import { ArtifactTypeSchema, queryBool } from '@bike4mind/common';
import { artifactService } from '@bike4mind/services';
import {
  artifactRepository,
  artifactContentRepository,
  artifactVersionRepository,
  sessionRepository,
  questRepository,
} from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { assertArtifactSourceRefsAccessible } from '@server/utils/assertArtifactSourceRefsAccessible';
import { z } from 'zod';
import qs from 'qs';

const ListArtifactsSchema = z.object({
  limit: z.coerce.number().min(1).max(100).prefault(20),
  offset: z.coerce.number().min(0).prefault(0),
  sortBy: z.enum(['type', 'title', 'createdAt', 'updatedAt']).prefault('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).prefault('desc'),
  includeDeleted: queryBool,
  type: z.string().optional(),
  status: z.enum(['draft', 'review', 'published', 'archived']).optional(),
  visibility: z.enum(['private', 'project', 'organization', 'public']).optional(),
  projectId: z.string().optional(),
  sessionId: z.string().optional(),
  tags: z.array(z.string()).prefault([]),
  search: z.string().optional(),
});

const CreateArtifactSchema = z.object({
  id: z.string().optional(),
  type: ArtifactTypeSchema,
  title: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  content: z.string().min(1),
  projectId: z.string().optional(),
  organizationId: z.string().optional(),
  visibility: z.enum(['private', 'project', 'organization', 'public']).prefault('private'),
  tags: z.array(z.string().max(50)).max(20).prefault([]),
  versionTag: z.string().max(100).optional(),
  sourceQuestId: z.string().optional(),
  sessionId: z.string().optional(),
  parentArtifactId: z.string().optional(),
  permissions: z
    .object({
      canRead: z.array(z.string()).prefault([]),
      canWrite: z.array(z.string()).prefault([]),
      canDelete: z.array(z.string()).prefault([]),
      isPublic: z.boolean().prefault(false),
      inheritFromProject: z.boolean().prefault(true),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).prefault({}),
});

const handler = baseApi()
  /**
   * GET /api/artifacts
   * List artifacts with filtering and pagination
   */
  .get(
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const queryParams = qs.parse(req.query as any);
      const validatedParams = ListArtifactsSchema.parse(queryParams);

      const result = await artifactService.list(userId, validatedParams, {
        db: {
          artifacts: artifactRepository as any,
        },
      });

      return res.json(result);
    })
  )
  /**
   * POST /api/artifacts
   * Create a new artifact
   */
  .post(
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const validatedData = CreateArtifactSchema.parse(req.body);

      // The refs below are written verbatim onto the new artifact, so a caller must be entitled to
      // any it supplies - otherwise it could claim another user's session/quest/artifact as its
      // source. Sessions are shareable and stamping a session is a write into its graph, so the bar
      // is update access (owner or update-shared), matching the collaborator-in-a-shared-session
      // flow; artifacts are not shareable, so parent stays owner-only.
      await assertArtifactSourceRefsAccessible(
        userId,
        {
          sessionId: validatedData.sessionId,
          sourceQuestId: validatedData.sourceQuestId,
          parentArtifactId: validatedData.parentArtifactId,
        },
        {
          canUpdateSession: async id => !!(await sessionRepository.shareable.findUpdateAccessById(req.user!, id)),
          getQuestSessionId: async id => (await questRepository.findById(id))?.sessionId ?? null,
          getArtifactOwner: async id => (await artifactRepository.findOne({ id }))?.userId ?? null,
        }
      );

      const result = await artifactService.create(userId, validatedData, {
        db: {
          artifacts: artifactRepository as any,
          artifactContents: artifactContentRepository as any,
          artifactVersions: artifactVersionRepository as any,
        },
      });

      return res.status(201).json(result);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

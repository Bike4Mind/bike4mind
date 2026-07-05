import { artifactService } from '@bike4mind/services';
import { artifactRepository, artifactContentRepository, artifactVersionRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { z } from 'zod';

const UpdateArtifactSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  content: z.string().min(1).optional(),
  visibility: z.enum(['private', 'project', 'organization', 'public']).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  versionTag: z.string().max(100).optional(),
  status: z.enum(['draft', 'review', 'published', 'archived']).optional(),
  permissions: z
    .object({
      canRead: z.array(z.string()).optional(),
      canWrite: z.array(z.string()).optional(),
      canDelete: z.array(z.string()).optional(),
      isPublic: z.boolean().optional(),
      inheritFromProject: z.boolean().optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createNewVersion: z.boolean().optional(),
  versionMessage: z.string().max(500).optional(),
});

const handler = baseApi()
  /**
   * GET /api/artifacts/[id]
   * Get artifact by ID with optional version and content parameters
   */
  .get(
    asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
      const userId = req.user?.id;
      const artifactId = req.query.id;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!artifactId) {
        throw new BadRequestError('Invalid artifact ID');
      }

      const {
        includeContent: includeContentParam,
        includeVersions: includeVersionsParam,
        version: versionParam,
      } = req.query as {
        id: string;
        includeContent?: string;
        includeVersions?: string;
        version?: string;
      };

      const includeContent = includeContentParam === 'true';
      const includeVersions = includeVersionsParam === 'true';
      const version = versionParam ? parseInt(versionParam, 10) : undefined;

      let result = await artifactService.get(
        userId,
        {
          id: artifactId,
          includeContent: includeContent !== false, // Default to true for backward compatibility
          includeVersions,
          version,
        } as any, // Temporary type assertion to bypass strict typing
        {
          db: {
            artifacts: artifactRepository as any,            artifactContents: artifactContentRepository as any,            artifactVersions: artifactVersionRepository as any,          },
        }
      );

      // If not found by exact ID, try finding by prefix (for legacy artifact IDs without timestamp)
      // This handles the case where UI uses artifact_react_todo-app but DB has artifact_react_todo-app_1759393649558_0
      if (!result) {
        const artifacts = await artifactRepository.find({
          id: { $regex: `^${artifactId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_\\d+_\\d+$` },
          userId,
          deletedAt: null,
        });

        if (artifacts && artifacts.length > 0) {
          // Get the most recent one (last in array since they're sorted by creation time)
          const latestArtifact = artifacts[artifacts.length - 1];

          result = await artifactService.get(
            userId,
            {
              id: latestArtifact.id,
              includeContent: includeContent !== false,
              includeVersions,
              version,
            } as any,
            {
              db: {
                artifacts: artifactRepository as any,
                artifactContents: artifactContentRepository as any,
                artifactVersions: artifactVersionRepository as any,
              },
            }
          );
        }
      }

      if (!result) {
        throw new NotFoundError('Artifact not found');
      }

      return res.json(result);
    })
  )
  /**
   * PUT /api/artifacts/[id]
   * Update artifact
   */
  .put(
    asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
      const userId = req.user?.id;
      const artifactId = req.query.id;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!artifactId) {
        throw new BadRequestError('Invalid artifact ID');
      }

      const validatedData = UpdateArtifactSchema.parse(req.body);

      const result = await artifactService.update(
        userId,
        { id: artifactId, ...validatedData },
        {
          db: {
            artifacts: artifactRepository as any,            artifactContents: artifactContentRepository as any,            artifactVersions: artifactVersionRepository as any,          },
        }
      );

      return res.json(result);
    })
  )
  /**
   * DELETE /api/artifacts/[id]
   * Soft delete artifact
   */
  .delete(
    asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
      const userId = req.user?.id;
      const artifactId = req.query.id;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!artifactId) {
        throw new BadRequestError('Invalid artifact ID');
      }

      const result = await artifactService.delete(
        userId,
        { id: artifactId, hardDelete: false },        {
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

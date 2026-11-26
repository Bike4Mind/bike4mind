import { ARTIFACT_DB } from '@bike4mind/server-utils/artifacts/artifactAccess';
import { artifactService } from '@bike4mind/services';
import { artifactRepository, artifactContentRepository, artifactVersionRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ApiKeyScope } from '@bike4mind/common';
import { assertApiKeyScope } from '@bike4mind/server-utils/middlewares/apiKeyScopeGate';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { hideArtifactDenial } from '@bike4mind/server-utils/artifacts/artifactAccess';
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

const NOTEBOOKS_WRITE_REQUIRED = 'This API key is read-only for notebooks; notebooks:write is required';

// Gated per verb below: the route-level scopes admit read keys for the GET.
const handler = baseApi({ requiredScopes: [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.WRITE_NOTEBOOKS] })
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

      // A denied read is a 404 like a missing artifact: a 401 here would sign the SPA out (the
      // client treats 401 as an expired session) when a user opens someone else's /artifacts/$id.
      const result = await hideArtifactDenial(
        artifactService.get(
          userId,
          {
            id: artifactId,
            includeContent: includeContent !== false, // Default to true for backward compatibility
            includeVersions,
            version,
          },
          {
            db: {
              artifacts: artifactRepository,
              artifactContents: artifactContentRepository,
              artifactVersions: artifactVersionRepository,
            },
          }
        )
      );

      return res.json(result);
    })
  )
  /**
   * PUT /api/artifacts/[id]
   * Update artifact
   */
  .put(
    asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
      assertApiKeyScope(req, [ApiKeyScope.WRITE_NOTEBOOKS], NOTEBOOKS_WRITE_REQUIRED);
      const userId = req.user?.id;
      const artifactId = req.query.id;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!artifactId) {
        throw new BadRequestError('Invalid artifact ID');
      }

      const validatedData = UpdateArtifactSchema.parse(req.body);

      const result = await artifactService.update(userId, { id: artifactId, ...validatedData }, { db: ARTIFACT_DB });

      return res.json(result);
    })
  )
  /**
   * DELETE /api/artifacts/[id]
   * Soft delete artifact
   */
  .delete(
    asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
      assertApiKeyScope(req, [ApiKeyScope.WRITE_NOTEBOOKS], NOTEBOOKS_WRITE_REQUIRED);
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
        { id: artifactId, hardDelete: false },
        {
          db: {
            artifacts: artifactRepository,
          },
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

import { artifactService } from '@bike4mind/services';
import { artifactRepository, artifactContentRepository, artifactVersionRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { z } from 'zod';

const CreateVersionSchema = z.object({
  versionTag: z.string().max(100).optional(),
  changeDescription: z.string().max(500).optional(),
  content: z.string().min(1).optional(), // Optional because we might just be creating a version marker
});

const handler = baseApi()
  /**
   * GET /api/artifacts/[id]/versions
   * Get all versions for an artifact
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

      // First check if user has access to the artifact
      const artifact = await artifactService.get(
        userId,
        { id: artifactId, includeContent: false, includeVersions: false },
        {
          db: {
            artifacts: artifactRepository as any,
            artifactContents: artifactContentRepository as any,
            artifactVersions: artifactVersionRepository as any,
          },
        }
      );

      if (!artifact) {
        throw new NotFoundError('Artifact not found');
      }

      const versions = await artifactVersionRepository.findByArtifactId(artifactId);

      return res.json({
        success: true,
        data: versions,
        total: versions.length,
      });
    })
  )
  /**
   * POST /api/artifacts/[id]/versions
   * Create a new version of an artifact
   */
  .post(
    asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
      const userId = req.user?.id;
      const artifactId = req.query.id;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!artifactId) {
        throw new BadRequestError('Invalid artifact ID');
      }

      const validatedData = CreateVersionSchema.parse(req.body);

      // Get current artifact to check permissions and get latest version
      const artifact = await artifactService.get(
        userId,
        { id: artifactId, includeContent: true, includeVersions: false },
        {
          db: {
            artifacts: artifactRepository as any,
            artifactContents: artifactContentRepository as any,
            artifactVersions: artifactVersionRepository as any,
          },
        }
      );

      if (!artifact) {
        throw new NotFoundError('Artifact not found');
      }

      // Create new version by updating the artifact
      const updateData: any = {
        versionTag: validatedData.versionTag,
        // If content is provided, use it; otherwise keep existing content
        ...(validatedData.content && { content: validatedData.content }),
      };

      const updatedArtifact = await artifactService.update(
        userId,
        {
          id: artifactId,
          ...updateData,
          createNewVersion: true,
          versionMessage: validatedData.changeDescription || `Version ${artifact.artifact.version + 1}`,
        },
        {
          db: {
            artifacts: artifactRepository as any,
            artifactContents: artifactContentRepository as any,
            artifactVersions: artifactVersionRepository as any,
          },
        }
      );

      return res.status(201).json({
        success: true,
        data: updatedArtifact,
      });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

import { artifactVersionRepository, artifactContentRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';

const handler = baseApi()
  /**
   * GET /api/artifacts/[id]/versions/[version]
   * Get content for a specific version of an artifact
   */
  .get(
    asyncHandler<{}, unknown, unknown, { id: string; version: string }>(async (req, res) => {
      const userId = req.user?.id;
      const { id: artifactId, version } = req.query;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const versionNumber = parseInt(version as string, 10);
      if (isNaN(versionNumber)) {
        return res.status(400).json({ error: 'Invalid version number' });
      }

      const versionDoc = await artifactVersionRepository.findByVersion(artifactId as string, versionNumber);

      if (!versionDoc) {
        // TEMPORARY FALLBACK: If version field is missing, try to find by index
        console.warn(`Version ${versionNumber} not found by version field, trying by index`);

        // Get all versions for this artifact and sort by creation date
        const allVersions = await artifactVersionRepository.findByArtifactId(artifactId as string);
        const sortedVersions = allVersions.sort(
          (a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );

        // Get the version by index (version 1 = index 0, etc.)
        const versionByIndex = sortedVersions[versionNumber - 1];

        if (!versionByIndex) {
          throw new NotFoundError('Version not found');
        }

        const content = await artifactContentRepository.findById(versionByIndex.contentId.toString());

        if (!content) {
          throw new NotFoundError('Version content not found');
        }

        return res.json({
          success: true,
          data: {
            version: versionNumber,
            content: content.content,
            versionTag: versionByIndex.versionTag,
            createdAt: versionByIndex.createdAt,
          },
        });
      }

      const content = await artifactContentRepository.findById(versionDoc.contentId.toString());

      if (!content) {
        throw new NotFoundError('Version content not found');
      }

      return res.json({
        success: true,
        data: {
          version: versionNumber,
          content: content.content,
          versionTag: versionDoc.versionTag,
          createdAt: versionDoc.createdAt,
        },
      });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

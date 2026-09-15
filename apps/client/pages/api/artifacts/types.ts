import { ArtifactTypeSchema, ARTIFACT_TYPE_REGISTRY, ARTIFACT_CATEGORIES } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';

// Derive artifact types from centralized registry - ensures all types are always included
const ARTIFACT_TYPES = ArtifactTypeSchema.options.map(type => ({
  type,
  ...ARTIFACT_TYPE_REGISTRY[type],
}));

const handler = baseApi()
  /**
   * GET /api/artifacts/types
   * Get available artifact types and their metadata
   */
  .get(
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      return res.json({
        types: ARTIFACT_TYPES,
        categories: ARTIFACT_CATEGORIES,
      });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

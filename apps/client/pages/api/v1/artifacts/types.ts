/**
 * GET /api/v1/artifacts/types - the artifact type catalog, derived from ARTIFACT_TYPE_REGISTRY so a
 * new type is published the moment it is registered. The public twin of GET /api/artifacts/types.
 */

import {
  ARTIFACT_CATEGORIES,
  ARTIFACT_TYPE_REGISTRY,
  ArtifactTypeSchema,
  listArtifactTypesContract,
} from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';

const TYPES = ArtifactTypeSchema.options.map(type => {
  const { name, description, category, mimeType } = ARTIFACT_TYPE_REGISTRY[type];
  return { type, name, description, category, mime_type: mimeType };
});

const handler = nextRouteForContract(listArtifactTypesContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/artifacts/types'),
}).get(async (_req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ types: TYPES, categories: [...ARTIFACT_CATEGORIES] });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

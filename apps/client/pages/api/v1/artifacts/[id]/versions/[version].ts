/**
 * GET /api/v1/artifacts/{id}/versions/{version} - one version with its content. Read access is
 * checked through artifactService.get first, as the SPA route does. Unlike that route there is no
 * fallback to the createdAt order for version rows missing a `version` number: a miss is a 404.
 */

import { getArtifactVersionContract } from '@bike4mind/common';
import { artifactContentRepository, artifactVersionRepository } from '@bike4mind/database';
import { artifactService } from '@bike4mind/services';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { rateLimit } from '@server/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';
import { NotFoundError } from '@server/utils/errors';
import { toPublicArtifactVersion } from '@server/artifacts/toPublicArtifact';
import { ARTIFACT_DB, hideArtifactDenial } from '@server/artifacts/artifactAccess';

const handler = nextRouteForContract(getArtifactVersionContract, {
  rateLimit: rateLimit({
    limit: req => resolveUserRateLimitPerMin(req.user),
    windowMs: 60 * 1000,
    bucket: 'GET /api/v1/artifacts/[id]/versions/[version]',
  }),
}).get(async (req, res) => {
  const { id, version } = req.validatedParams;
  // A malformed version is a 404 like a missing one (CONVENTIONS.md status table).
  if (!/^[1-9]\d{0,8}$/.test(version)) throw new NotFoundError('Version not found');

  const { artifact } = await hideArtifactDenial(
    artifactService.get(req.user.id, { id, includeContent: false, includeVersions: false }, { db: ARTIFACT_DB })
  );
  const versionDoc = await artifactVersionRepository.findByVersion(artifact.id, Number(version));
  const content = versionDoc && (await artifactContentRepository.findById(String(versionDoc.contentId)));
  if (!versionDoc || !content) throw new NotFoundError('Version not found');

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(toPublicArtifactVersion(versionDoc, content.content));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

/**
 * GET    /api/v1/artifacts/{id} - read one artifact with its current content.
 * PATCH  /api/v1/artifacts/{id} - partial update; changed content creates a new version.
 * DELETE /api/v1/artifacts/{id} - soft delete.
 *
 * The public twins of /api/artifacts/[id], calling the same artifactService. The service answers a
 * denied read, write or delete with UnauthorizedError (the SPA route's 401); here every one of them
 * is a 404, so a caller cannot tell an artifact it may not touch from one that does not exist.
 */

import { deleteArtifactContract, getArtifactContract, updateArtifactContract } from '@bike4mind/common';
import { artifactService } from '@bike4mind/services';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { rateLimit } from '@server/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';
import { toPublicArtifact } from '@server/artifacts/toPublicArtifact';
import { ARTIFACT_DB, hideArtifactDenial } from '@server/artifacts/artifactAccess';

const perUserRateLimit = (bucket: string) =>
  rateLimit({ limit: req => resolveUserRateLimitPerMin(req.user), windowMs: 60 * 1000, bucket });

async function readWithContent(userId: string, id: string) {
  const { artifact, content } = await hideArtifactDenial(
    artifactService.get(userId, { id, includeContent: true, includeVersions: false }, { db: ARTIFACT_DB })
  );
  return toPublicArtifact(artifact, content?.content ?? null);
}

const getRoute = nextRouteForContract(getArtifactContract, {
  rateLimit: perUserRateLimit('GET /api/v1/artifacts/[id]'),
}).get(async (req, res) => {
  const body = await readWithContent(req.user.id, req.validatedParams.id);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(body);
});

const updateRoute = nextRouteForContract(updateArtifactContract, {
  rateLimit: perUserRateLimit('PATCH /api/v1/artifacts/[id]'),
}).patch(async (req, res) => {
  const { id } = req.validatedParams;
  const { title, description, content, tags } = req.validated;

  await hideArtifactDenial(
    artifactService.update(
      req.user.id,
      {
        id,
        // Spread so an omitted field stays absent instead of being set undefined.
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(content !== undefined && { content }),
        ...(tags !== undefined && { tags }),
      },
      { db: ARTIFACT_DB }
    )
  );

  // Re-read for the current content: update returns the new content row only when it changed.
  const body = await readWithContent(req.user.id, id);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(body);
});

const deleteRoute = nextRouteForContract(deleteArtifactContract, {
  rateLimit: perUserRateLimit('DELETE /api/v1/artifacts/[id]'),
}).delete(async (req, res) => {
  await hideArtifactDenial(
    artifactService.delete(req.user.id, { id: req.validatedParams.id, hardDelete: false }, { db: ARTIFACT_DB })
  );
  return res.status(204).end();
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default dispatchByMethod({ GET: getRoute, PATCH: updateRoute, DELETE: deleteRoute });

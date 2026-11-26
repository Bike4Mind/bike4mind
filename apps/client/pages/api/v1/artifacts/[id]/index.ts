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
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { toPublicArtifact } from '@server/artifacts/toPublicArtifact';
import { isSupersededSave, readPointedContent } from '@server/artifacts/supersededSave';
import { ARTIFACT_DB, hideArtifactDenial } from '@bike4mind/server-utils/artifacts/artifactAccess';

const getRoute = nextRouteForContract(getArtifactContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/artifacts/[id]'),
}).get(async (req, res) => {
  const { artifact, content } = await hideArtifactDenial(
    artifactService.get(
      req.user.id,
      { id: req.validatedParams.id, includeContent: true, includeVersions: false },
      { db: ARTIFACT_DB }
    )
  );
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(toPublicArtifact(artifact, content?.content ?? null));
});

const updateRoute = nextRouteForContract(updateArtifactContract, {
  rateLimit: perUserRateLimit('PATCH /api/v1/artifacts/[id]'),
}).patch(async (req, res) => {
  const { id } = req.validatedParams;
  const { title, description, content, tags } = req.validated;

  const { artifact, version } = await hideArtifactDenial(
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

  // No-row saves must read the returned pointer too: another save may have moved it since hashing.
  // Keep write-only saves successful without disclosing loaded content.
  const current =
    !version || isSupersededSave(artifact, version)
      ? await readPointedContent(req.user.id, artifact)
      : (content ?? (await readPointedContent(req.user.id, artifact)));
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(toPublicArtifact(artifact, current));
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

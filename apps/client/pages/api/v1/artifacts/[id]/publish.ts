/**
 * POST   /api/v1/artifacts/{id}/publish - publish the stored artifact as a page, with an optional
 *        access gate applied in the same write as the visibility.
 * DELETE /api/v1/artifacts/{id}/publish - take the page down.
 *
 * The public counterpart of the upload-url / finalize flow under /api/publish, which stays as it is
 * for the web app. The server reads the stored content itself.
 */

import { publishArtifactContract, unpublishArtifactContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertOutboundActionAllowed } from '@server/auth/assertOutboundActionAllowed';
import { publishStoredArtifact, unpublishStoredArtifact } from '@server/services/publish/publishStoredArtifact';
import { loadArtifactForPublish, toPublishedArtifactResource } from '@server/artifacts/publishStoredArtifactHelpers';

const publishRoute = nextRouteForContract(publishArtifactContract, {
  rateLimit: perUserRateLimit('POST /api/v1/artifacts/[id]/publish'),
}).post(async (req, res) => {
  await assertOutboundActionAllowed(req.user, req);
  const { slug, visibility, access_gate } = req.validated;
  const { artifact, content } = await loadArtifactForPublish(String(req.user.id), req.validatedParams.id);

  const page = await publishStoredArtifact({
    user: req.user,
    artifact,
    content,
    logger: req.logger,
    slug,
    visibility,
    accessGate: access_gate,
  });

  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(201).json(toPublishedArtifactResource(artifact.id, page));
});

const unpublishRoute = nextRouteForContract(unpublishArtifactContract, {
  rateLimit: perUserRateLimit('DELETE /api/v1/artifacts/[id]/publish'),
}).delete(async (req, res) => {
  // No artifact read: the page is found by owner and source id, so one whose artifact was deleted can still be taken down.
  await unpublishStoredArtifact({ user: req.user, artifactId: req.validatedParams.id, logger: req.logger });
  return res.status(204).end();
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default dispatchByMethod({ POST: publishRoute, DELETE: unpublishRoute });

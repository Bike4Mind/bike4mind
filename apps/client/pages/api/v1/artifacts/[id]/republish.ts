/**
 * POST /api/v1/artifacts/{id}/republish - replace the page's content with the artifact's current
 * version. Address, visibility and access gate are kept.
 */

import { republishArtifactContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertOutboundActionAllowed } from '@server/auth/assertOutboundActionAllowed';
import { republishStoredArtifact } from '@server/services/publish/publishStoredArtifact';
import { loadArtifactForPublish, toPublishedArtifactResource } from '@server/artifacts/publishStoredArtifactHelpers';

const handler = nextRouteForContract(republishArtifactContract, {
  rateLimit: perUserRateLimit('POST /api/v1/artifacts/[id]/republish'),
}).post(async (req, res) => {
  await assertOutboundActionAllowed(req.user, req);
  const { artifact, content } = await loadArtifactForPublish(String(req.user.id), req.validatedParams.id);

  const page = await republishStoredArtifact({ user: req.user, artifact, content, logger: req.logger });

  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json(toPublishedArtifactResource(artifact.id, page));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

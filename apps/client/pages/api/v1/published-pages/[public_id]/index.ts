/**
 * GET    /api/v1/published-pages/{public_id} - management metadata of a page the caller manages.
 * PATCH  /api/v1/published-pages/{public_id} - update it.
 * DELETE /api/v1/published-pages/{public_id} - take it down.
 *
 * A page the caller does not manage is a 404 on all three, never the public-viewer view.
 */

import { deletePublishedPageContract, getPublishedPageContract, updatePublishedPageContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertOutboundActionAllowed } from '@server/auth/assertOutboundActionAllowed';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import {
  deletePublishedPage,
  getPublishedPage,
  updatePublishedPage,
  type PublishedPagePatch,
} from '@server/services/publish/managePublishedPages';
import { toPublishedPageResource } from '@server/publish/publishedPageResource';
import { withDeclaredStatuses } from '@server/publish/v1PublishedPageRoute';

const getRoute = nextRouteForContract(getPublishedPageContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/published-pages/[public_id]'),
}).get(async (req, res) => {
  const { artifact, isManager } = await withDeclaredStatuses([404], () =>
    getPublishedPage({ user: req.user, publicId: req.validatedParams.public_id })
  );
  if (!isManager) throw new NotFoundError('Published page not found');

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(toPublishedPageResource(artifact));
});

const patchRoute = nextRouteForContract(updatePublishedPageContract, {
  rateLimit: perUserRateLimit('PATCH /api/v1/published-pages/[public_id]'),
}).patch(async (req, res) => {
  await assertOutboundActionAllowed(req.user, req);
  const body = req.validated;
  const gate = body.access_gate;

  const patch: PublishedPagePatch = {
    title: body.title,
    description: body.description,
    tags: body.tags,
    visibility: body.visibility,
    commentPolicy: body.comment_policy,
    discoverable: body.discoverable,
    embedOrigins: body.embed_origins,
  };
  if (gate !== undefined) {
    patch.accessGate =
      gate === null || gate.kind === 'passphrase' ? gate : { kind: 'domain', allowedDomains: gate.allowed_domains };
  }

  const updated = await withDeclaredStatuses([404, 422], () =>
    updatePublishedPage({
      user: req.user,
      logger: req.logger,
      publicId: req.validatedParams.public_id,
      patch,
      request: req,
    })
  );

  return res.json(toPublishedPageResource(updated));
});

const deleteRoute = nextRouteForContract(deletePublishedPageContract, {
  rateLimit: perUserRateLimit('DELETE /api/v1/published-pages/[public_id]'),
}).delete(async (req, res) => {
  await assertOutboundActionAllowed(req.user, req);
  await withDeclaredStatuses([404], () =>
    deletePublishedPage({ user: req.user, logger: req.logger, publicId: req.validatedParams.public_id })
  );
  return res.status(204).end();
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default dispatchByMethod({ GET: getRoute, PATCH: patchRoute, DELETE: deleteRoute });

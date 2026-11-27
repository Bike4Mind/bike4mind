/**
 * GET  /api/v1/published-pages/{public_id}/share-links - the live links, redacted to an id and a token hint.
 * POST /api/v1/published-pages/{public_id}/share-links - mint another link; the only response carrying its URL.
 */

import { createPublishedPageShareLinkContract, listPublishedPageShareLinksContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertOutboundActionAllowed } from '@server/auth/assertOutboundActionAllowed';
import { createShareLink, listShareLinks } from '@server/services/publish/shareLinks';
import {
  toCreatedShareLinkResource,
  toShareLinkResource,
  withStatusMap,
} from '@server/publish/publishedPageSubresources';

// A non-owner is a 404 (ids are not probeable); the live-link limit and a bad expiry are validation failures.
const toDeclaredStatus = (error: { statusCode: number }) =>
  error.statusCode === 403 ? 404 : error.statusCode === 400 ? 422 : undefined;

const listRoute = nextRouteForContract(listPublishedPageShareLinksContract, {
  rateLimit: perUserRateLimit('GET /api/v1/published-pages/[public_id]/share-links'),
}).get(async (req, res) => {
  // The set is bounded by the live-link ceiling, so one response holds all of it.
  const links = await withStatusMap(
    () => listShareLinks({ user: req.user, logger: req.logger, publicId: req.validatedParams.public_id }),
    toDeclaredStatus
  );
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({ data: links.map(toShareLinkResource), next_cursor: null });
});

const createRoute = nextRouteForContract(createPublishedPageShareLinkContract, {
  rateLimit: perUserRateLimit('POST /api/v1/published-pages/[public_id]/share-links'),
}).post(async (req, res) => {
  await assertOutboundActionAllowed(req.user, req);
  const result = await withStatusMap(
    () =>
      createShareLink({
        user: req.user,
        logger: req.logger,
        publicId: req.validatedParams.public_id,
        additional: true,
        expiresAt: req.validated.expires_at,
      }),
    toDeclaredStatus
  );
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(201).json(toCreatedShareLinkResource(result));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default dispatchByMethod({ GET: listRoute, POST: createRoute });

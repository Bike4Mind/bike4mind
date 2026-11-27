/**
 * GET  /api/v1/published-pages/{public_id}/share-links - the live links, redacted to an id and a token hint.
 * POST /api/v1/published-pages/{public_id}/share-links - mint another link; the only response carrying its URL.
 */

import { createPublishedPageShareLinkContract, listPublishedPageShareLinksContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertOutboundActionAllowed } from '@server/auth/assertOutboundActionAllowed';
import { paginateById } from '@server/utils/cursorPagination';
import { createShareLink, listShareLinks } from '@server/services/publish/shareLinks';
import {
  loadManagedPage,
  toCreatedShareLinkResource,
  toShareLinkResource,
} from '@server/publish/publishedPageSubresources';
import { declaredStatuses, withStatusMap } from '@server/publish/v1PublishedPageRoute';

const CURSOR_SCOPE = 'v1.published-page-share-links';

// The live-link limit and a bad expiry are validation failures.
const toDeclared = declaredStatuses([404, 422]);

const listRoute = nextRouteForContract(listPublishedPageShareLinksContract, {
  rateLimit: perUserRateLimit('GET /api/v1/published-pages/[public_id]/share-links'),
}).get(async (req, res) => {
  const { public_id } = req.validatedParams;
  await loadManagedPage(req.user, public_id);
  const links = await withStatusMap(
    () => listShareLinks({ user: req.user, logger: req.logger, publicId: public_id }),
    toDeclared
  );
  // The set is bounded by the live-link ceiling, so it is paged in memory.
  const { items, nextCursor } = paginateById(links, { ...req.validatedQuery, scope: CURSOR_SCOPE });
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({ data: items.map(toShareLinkResource), next_cursor: nextCursor });
});

const createRoute = nextRouteForContract(createPublishedPageShareLinkContract, {
  rateLimit: perUserRateLimit('POST /api/v1/published-pages/[public_id]/share-links'),
}).post(async (req, res) => {
  await assertOutboundActionAllowed(req.user, req);
  const { public_id } = req.validatedParams;
  await loadManagedPage(req.user, public_id);
  const result = await withStatusMap(
    () =>
      createShareLink({
        user: req.user,
        logger: req.logger,
        publicId: public_id,
        additional: true,
        expiresAt: req.validated.expires_at,
      }),
    toDeclared
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

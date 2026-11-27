/**
 * GET  /api/v1/published-pages/{public_id}/comments - the comments on a page the caller manages.
 * POST /api/v1/published-pages/{public_id}/comments - add one.
 *
 * v1 is owner-scoped: it manages the comments on the caller's own pages; viewer commenting stays on
 * the page itself.
 */

import { createPublishedPageCommentContract, listPublishedPageCommentsContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertOutboundActionAllowed } from '@server/auth/assertOutboundActionAllowed';
import { createAnnotation, listAnnotations } from '@server/services/publish/annotations';
import {
  fromCommentAnchor,
  loadManagedPage,
  toCommentResource,
  withStatusMap,
} from '@server/publish/publishedPageSubresources';

const listRoute = nextRouteForContract(listPublishedPageCommentsContract, {
  rateLimit: perUserRateLimit('GET /api/v1/published-pages/[public_id]/comments'),
}).get(async (req, res) => {
  const { public_id } = req.validatedParams;
  await loadManagedPage(req.user, public_id);
  const { annotations } = await listAnnotations({ user: req.user, publicId: public_id });
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({ data: annotations.map(toCommentResource), next_cursor: null });
});

const createRoute = nextRouteForContract(createPublishedPageCommentContract, {
  rateLimit: perUserRateLimit('POST /api/v1/published-pages/[public_id]/comments'),
}).post(async (req, res) => {
  await assertOutboundActionAllowed(req.user, req);
  const { public_id } = req.validatedParams;
  const { body, anchor, thread_root_id } = req.validated;
  await loadManagedPage(req.user, public_id);
  const created = await withStatusMap(
    () =>
      createAnnotation({
        user: req.user,
        publicId: public_id,
        logger: req.logger,
        input: {
          body,
          anchor: anchor && fromCommentAnchor(anchor),
          threadRootId: thread_root_id,
        },
      }),
    // A disabled comment policy and a bad thread root are request problems, not a missing scope.
    error => (error.statusCode === 400 || error.additionalInfo?.errorCode === 'comments_disabled' ? 422 : undefined)
  );
  return res.status(201).json(toCommentResource(created));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default dispatchByMethod({ GET: listRoute, POST: createRoute });

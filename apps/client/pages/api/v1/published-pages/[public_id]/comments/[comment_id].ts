/**
 * PATCH  /api/v1/published-pages/{public_id}/comments/{comment_id} - edit or resolve a comment.
 * DELETE /api/v1/published-pages/{public_id}/comments/{comment_id} - delete it.
 */

import { deletePublishedPageCommentContract, updatePublishedPageCommentContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertOutboundActionAllowed } from '@server/auth/assertOutboundActionAllowed';
import { deleteAnnotation, updateAnnotation } from '@server/services/publish/annotations';
import { loadManagedPage, toCommentResource } from '@server/publish/publishedPageSubresources';
import { withStatusMap } from '@server/publish/v1PublishedPageRoute';

// A malformed id names no comment.
const toDeclaredStatus = (error: { statusCode: number }) => (error.statusCode === 400 ? 404 : undefined);

const updateRoute = nextRouteForContract(updatePublishedPageCommentContract, {
  rateLimit: perUserRateLimit('PATCH /api/v1/published-pages/[public_id]/comments/[comment_id]'),
}).patch(async (req, res) => {
  await assertOutboundActionAllowed(req.user, req);
  const { public_id, comment_id } = req.validatedParams;
  await loadManagedPage(req.user, public_id);
  const updated = await withStatusMap(
    () => updateAnnotation({ user: req.user, publicId: public_id, id: comment_id, input: req.validated }),
    toDeclaredStatus
  );
  return res.status(200).json(toCommentResource(updated));
});

const deleteRoute = nextRouteForContract(deletePublishedPageCommentContract, {
  rateLimit: perUserRateLimit('DELETE /api/v1/published-pages/[public_id]/comments/[comment_id]'),
}).delete(async (req, res) => {
  const { public_id, comment_id } = req.validatedParams;
  await loadManagedPage(req.user, public_id);
  await withStatusMap(
    () => deleteAnnotation({ user: req.user, publicId: public_id, id: comment_id, logger: req.logger }),
    toDeclaredStatus
  );
  return res.status(204).end();
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default dispatchByMethod({ PATCH: updateRoute, DELETE: deleteRoute });

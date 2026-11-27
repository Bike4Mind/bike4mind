/**
 * DELETE /api/v1/published-pages/{public_id}/share-links/{link_id} - revoke one share link.
 */

import { revokePublishedPageShareLinkContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { revokeShareLink, SHARE_LINK_ERROR_CODES } from '@server/services/publish/shareLinks';
import { loadManagedPage } from '@server/publish/publishedPageSubresources';
import { withStatusMap } from '@server/publish/v1PublishedPageRoute';

export default nextRouteForContract(revokePublishedPageShareLinkContract, {
  rateLimit: perUserRateLimit('DELETE /api/v1/published-pages/[public_id]/share-links/[link_id]'),
}).delete(async (req, res) => {
  const { public_id, link_id } = req.validatedParams;
  await loadManagedPage(req.user, public_id);
  await withStatusMap(
    () => revokeShareLink({ user: req.user, logger: req.logger, publicId: public_id, id: link_id }),
    error => {
      if (error.statusCode === 403) return 404;
      // A malformed id names no live link.
      if (error.statusCode === 400) {
        return error.additionalInfo?.errorCode === SHARE_LINK_ERROR_CODES.wouldOrphanGate ? 409 : 404;
      }
      return undefined;
    }
  );
  return res.status(204).end();
});

export const config = {
  api: {
    externalResolver: true,
  },
};

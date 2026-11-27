/**
 * POST /api/v1/published-pages/{public_id}/restore - roll index.html back to an earlier version.
 */

import { restorePublishedPageVersionContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertOutboundActionAllowed } from '@server/auth/assertOutboundActionAllowed';
import { restorePublishedVersion } from '@server/services/publish/restorePublishedVersion';
import { getPublishedPage } from '@server/services/publish/managePublishedPages';
import { toPublishedPageResource } from '@server/publish/publishedPageResource';
import { loadManagedPage, withStatusMap } from '@server/publish/publishedPageSubresources';

export default nextRouteForContract(restorePublishedPageVersionContract, {
  rateLimit: perUserRateLimit('POST /api/v1/published-pages/[public_id]/restore'),
}).post(async (req, res) => {
  await assertOutboundActionAllowed(req.user, req);
  const { public_id } = req.validatedParams;
  await loadManagedPage(req.user, public_id);
  // "No previous version" and "not a known version" are 400s in the service; the contract calls them 422.
  await withStatusMap(
    () => restorePublishedVersion({ user: req.user, logger: req.logger, publicId: public_id, sha: req.validated.sha }),
    error => (error.statusCode === 400 ? 422 : error.statusCode === 403 ? 404 : undefined)
  );
  const { artifact } = await getPublishedPage({ user: req.user, publicId: public_id });
  return res.status(200).json(toPublishedPageResource(artifact));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

/**
 * POST /api/v1/published-pages/uploads/{draft_id}/finalize - step 3 of publishing a bundle: verify the
 * uploaded files, validate index.html and promote the draft to the live page.
 */

import { finalizePublishedPageContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertOutboundActionAllowed } from '@server/auth/assertOutboundActionAllowed';
import { finalizeBundle } from '@server/services/publish/publishBundle';
import { getPublishedPage } from '@server/services/publish/managePublishedPages';
import { toBundlePublisher, withStatusMap, declaredStatuses } from '@server/publish/v1PublishedPageRoute';
import { toPublishedPageResource } from '@server/publish/publishedPageResource';

export default nextRouteForContract(finalizePublishedPageContract, {
  rateLimit: perUserRateLimit('POST /api/v1/published-pages/uploads/[draft_id]/finalize'),
}).post(async (req, res) => {
  await assertOutboundActionAllowed(req.user, req);

  const page = await withStatusMap(
    async () => {
      const published = await finalizeBundle({
        user: toBundlePublisher(req.user),
        logger: req.logger,
        draftId: req.validatedParams.draft_id,
      });
      return getPublishedPage({ user: req.user, publicId: published.publicId });
    },
    declaredStatuses([404, 409, 422, 429])
  );

  return res.status(200).json(toPublishedPageResource(page.artifact));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

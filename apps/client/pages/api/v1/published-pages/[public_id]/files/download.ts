/**
 * GET /api/v1/published-pages/{public_id}/files/download?path= - 303 to a short-lived signed URL of one file.
 */

import { downloadPublishedPageFileContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { getPublishedArtifactsStorage } from '@bike4mind/server-utils/utils/storage/index';
import { resolveDocOrigin } from '@bike4mind/server-utils/services/publish/viewerSecurity';
import { resolveBundleDownload } from '@server/services/publish/resolveBundleDownload';
import { loadManagedPage } from '@server/publish/publishedPageSubresources';

export default nextRouteForContract(downloadPublishedPageFileContract, {
  rateLimit: perUserRateLimit('GET /api/v1/published-pages/[public_id]/files/download'),
}).get(async (req, res) => {
  const page = await loadManagedPage(req.user, req.validatedParams.public_id);
  const { url } = await resolveBundleDownload({
    storage: getPublishedArtifactsStorage(),
    artifact: page as unknown as Parameters<typeof resolveBundleDownload>[0]['artifact'],
    assetPath: req.validatedQuery.path,
    docOrigin: resolveDocOrigin(req.headers.host, req.headers['x-forwarded-proto']),
  });
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Location', url);
  return res.status(303).end();
});

export const config = {
  api: {
    externalResolver: true,
  },
};

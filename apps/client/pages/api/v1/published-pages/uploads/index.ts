/**
 * POST /api/v1/published-pages/uploads - step 1 of publishing a bundle: validate the declaration and
 * return a draft id with one presigned upload URL per file. Same service as /api/publish/artifact/upload-url.
 */

import { createPublishedPageUploadContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertOutboundActionAllowed } from '@server/auth/assertOutboundActionAllowed';
import { createBundleUpload } from '@server/services/publish/publishBundle';
import { toBundlePublisher, withDeclaredStatuses } from '@server/publish/v1PublishedPageRoute';

export default nextRouteForContract(createPublishedPageUploadContract, {
  rateLimit: perUserRateLimit('POST /api/v1/published-pages/uploads'),
}).post(async (req, res) => {
  await assertOutboundActionAllowed(req.user, req);
  const body = req.validated;

  const result = await withDeclaredStatuses([403, 409, 422, 429], () =>
    createBundleUpload({
      user: toBundlePublisher(req.user),
      logger: req.logger,
      tier: body.tier,
      scopeId: body.scope_id,
      slug: body.slug,
      title: body.title,
      description: body.description,
      visibility: body.visibility,
      tags: body.tags,
      gatedToGroupId: body.gated_to_group_id,
      commentPolicy: body.comment_policy,
      embedOrigins: body.embed_origins,
      files: body.files.map(f => ({ path: f.path, size: f.size, mimeType: f.mime_type })),
    })
  );

  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(201).json({
    draft_id: result.draftId,
    upload_urls: result.uploadUrls.map(u => ({
      path: u.path,
      url: u.url,
      expires_at: u.expiresAt,
      ...(u.headers && { headers: u.headers }),
    })),
  });
});

export const config = {
  api: {
    externalResolver: true,
    bodyParser: { sizeLimit: '256kb' }, // metadata only; the files go to the presigned URLs
  },
};

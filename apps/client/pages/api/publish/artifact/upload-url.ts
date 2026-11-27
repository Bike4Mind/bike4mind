import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { baseApi } from '@server/middlewares/baseApi';
import { UploadUrlRequestSchema, ApiKeyScope } from '@bike4mind/common';
import { createBundleUpload, toLegacyPublishErrorResponse } from '@server/services/publish/publishBundle';

/**
 * POST /api/publish/artifact/upload-url - step 1 of the 3-step publish flow.
 *
 * Client posts {tier, scopeId, slug, files[]}; server validates scope/visibility/
 * files, writes a draft manifest to S3 under drafts/{draftId}/, and returns a
 * draftId + per-file presigned PUT URLs. The bytes then go directly to S3 (the
 * 3-step flow exists because Lambda caps sync request bodies far below 50MB
 * bundles). /finalize promotes the draft to its canonical key.
 *
 * Ported from Polaris Publish via the artifact-publishing blueprint.
 */

const handler = baseApi({
  requiredScopes: [ApiKeyScope.ARTIFACTS_PUBLISH, ApiKeyScope.ADMIN],
  grandfatherLegacyKeys: true,
}).post(outboundActionGate(), async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const parsed = UploadUrlRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  }

  try {
    const response = await createBundleUpload({
      ...parsed.data,
      logger: req.logger,
      user: {
        id: String(req.user.id),
        username: (req.user as { username?: string }).username,
        isAdmin: req.user.isAdmin,
        organizationId: req.user.organizationId ? String(req.user.organizationId) : null,
        createdAt: (req.user as { createdAt?: Date | string | null }).createdAt,
      },
    });
    return res.status(200).json(response);
  } catch (err) {
    const legacy = toLegacyPublishErrorResponse(err);
    if (!legacy) throw err;
    return res.status(legacy.status).json(legacy.body);
  }
});

export const config = {
  api: {
    externalResolver: true,
    bodyParser: { sizeLimit: '256kb' }, // metadata only — files go via presigned URLs
  },
};

export default handler;

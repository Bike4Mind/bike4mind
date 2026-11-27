import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { baseApi } from '@server/middlewares/baseApi';
import { FinalizeRequestSchema, ApiKeyScope } from '@bike4mind/common';
import { finalizeBundle, toLegacyPublishErrorResponse } from '@server/services/publish/publishBundle';

/**
 * POST /api/publish/artifact/finalize - step 3 of the 3-step publish flow.
 *
 * Reads the draft manifest, re-checks permission (defense in depth), verifies
 * every file exists + hashes it, runs validateBundle on index.html, promotes
 * the draft to its canonical key, and upserts the PublishedArtifact record
 * (overwrite-in-place; captures previousVersionMeta). Returns 200 with the URL,
 * or 422 with structured violations. Ported from Polaris Publish.
 */

const handler = baseApi({
  requiredScopes: [ApiKeyScope.ARTIFACTS_PUBLISH, ApiKeyScope.ADMIN],
  grandfatherLegacyKeys: true,
}).post(outboundActionGate(), async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const parsed = FinalizeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  }

  try {
    const response = await finalizeBundle({
      draftId: parsed.data.draftId,
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
  api: { externalResolver: true },
};

export default handler;

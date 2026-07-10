import { baseApi } from '@server/middlewares/baseApi';
import { optionalAuth } from '@server/middlewares/optionalAuth';
import { PublishedArtifact } from '@bike4mind/database';
import type { CanCommentResponse, CommentPolicy, PublishVisibility } from '@bike4mind/common';
import { checkVisibility, canAnnotate, toPublishUser, requestHasGateProof } from '@server/services/publish';

/**
 * GET /api/publish/annotations/[publicId]/can-comment - the PER-VIEWER comment
 * capability, split out of the list GET so that list can be CDN-cached while
 * this stays no-store. The widget fetches it once on load (and on tab-refocus),
 * not on every poll. Anonymous viewers get `false`.
 */

interface ArtifactGateLean {
  publicId: string;
  visibility: PublishVisibility;
  ownerId: string;
  scopeId: string;
  commentPolicy: CommentPolicy;
  // Required (explicit null) to match VisibilityCheckArtifact; a lean read of a
  // pre-gate doc may omit it, so it's coerced `?? null` at the call below.
  accessGate: { kind: 'passphrase' | 'domain'; allowedDomains?: string[] } | null;
}

const handler = baseApi({ auth: false })
  .use(optionalAuth)
  .get(async (req, res) => {
    // Per-viewer - never cacheable. Set no-store BEFORE the gate so error
    // responses (400/401/403/404) are non-cacheable too.
    res.setHeader('Cache-Control', 'private, no-store');

    const publicId = String(req.query.publicId ?? '');
    if (!publicId) return res.status(400).json({ error: 'Missing publicId' });

    const doc = await PublishedArtifact.findOne({ publicId, deletedAt: null })
      .select('publicId visibility ownerId scopeId commentPolicy accessGate')
      .lean<Omit<ArtifactGateLean, 'accessGate'> & { accessGate?: ArtifactGateLean['accessGate'] }>();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const artifact: ArtifactGateLean = { ...doc, accessGate: doc.accessGate ?? null };

    const publishUser = toPublishUser(req.user);
    const vis = await checkVisibility(artifact, publishUser, {
      passphraseVerified: artifact.accessGate?.kind === 'passphrase' && requestHasGateProof(req, artifact.publicId),
    });
    if (!vis.ok) return res.status(vis.status).json({ error: vis.error });

    const response: CanCommentResponse = {
      commentPolicy: artifact.commentPolicy,
      canComment: canAnnotate(artifact, publishUser, true),
    };
    return res.status(200).json(response);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

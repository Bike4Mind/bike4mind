import { baseApi } from '@server/middlewares/baseApi';
import { optionalJwtAuth } from '@server/middlewares/optionalJwtAuth';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { z } from 'zod';
import { PublishedArtifact, shareTokenFilter } from '@bike4mind/database';
import { checkShareGrant, checkVisibility, toPublishUser } from '@server/services/publish';
import { parsePublishPath, segmentsFromViewerPathname } from '@server/services/publish/parsePublishPath';
import { requestHasGateProof } from '@bike4mind/server-utils/services/publish/publishGateToken';
import { recordVerifiedView } from '@server/services/publish/recordVerifiedView';
import type { PublishVisibility } from '@bike4mind/common';
import { hasQualifyingSocialParty } from '@server/services/gears/socialParty';

/** Record an admitted signed-in view reported by the bundle wrapper widget.
 * Navigation already records viewCount; this route records external analytics
 * and verified reward evidence without counting the navigation twice.
 */

const BodySchema = z.object({
  /** Browser location.pathname of the viewer page: /p/..., /uc/..., or /a/<token>. */
  path: z.string().min(3).max(512),
});

type ViewLean = {
  publicId: string;
  ownerId: string;
  verifiedExternalViewCount?: number;
  scopeId: string;
  visibility: PublishVisibility;
  accessGate?: { kind: 'passphrase' | 'domain'; allowedDomains?: string[] } | null;
} | null;

// Bearer only, never X-API-Key: this exists for a browser on the viewer page, and an API key
// would add a key-reachable route with no scope posture (apiKeyScopePostureCoverage.test.ts).
const handler = baseApi({ auth: false })
  .use(optionalJwtAuth())
  // Abuse bound only: the gear needs one view, so a legitimate viewer sends one per page load.
  .use(rateLimit({ limit: 30, windowMs: 60_000, bucket: 'publish-view' }))
  .post(async (req, res) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });

    // optionalJwtAuth already degrades these to anonymous; repeated because this route is
    // `auth: false`, so the full-auth chain's mfaPending gate and oauthRouteGate never run on it
    // (same belt-and-suspenders as gate/owner.ts).
    const principal = req.user;
    if (!principal?.id || principal.mfaPending || principal.oauthGrant) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const segments = segmentsFromViewerPathname(parsed.data.path);
    const resolved = segments ? parsePublishPath(segments) : null;
    if (!resolved) return res.status(404).json({ error: 'Not found' });

    const isShare = resolved.kind === 'share';
    const query =
      resolved.kind === 'bundle'
        ? { tier: resolved.tier, scopeId: resolved.scopeId, slug: resolved.slug, deletedAt: null }
        : resolved.kind === 'share'
          ? { ...shareTokenFilter(resolved.shareToken), deletedAt: null }
          : { publicId: resolved.publicId, 'source.kind': resolved.kind, deletedAt: null };

    const artifact = await PublishedArtifact.findOne(query)
      .select('publicId ownerId scopeId visibility accessGate.kind accessGate.allowedDomains verifiedExternalViewCount')
      .lean<ViewLean>();
    if (!artifact) return res.status(404).json({ error: 'Not found' });

    // The same admission the serve route applies, so a view is only ever counted for a viewer
    // who could have seen the page. Any refusal is a plain 404: this endpoint confirms nothing
    // a caller could not learn from the URL.
    const gateArtifact = { ...artifact, accessGate: artifact.accessGate ?? null };
    const passphraseVerified =
      gateArtifact.accessGate?.kind === 'passphrase' && requestHasGateProof(req, artifact.publicId);
    const user = toPublishUser(principal);
    const access = isShare
      ? await checkShareGrant(gateArtifact, { user, passphraseVerified })
      : await checkVisibility(gateArtifact, user, { passphraseVerified });
    if (!access.ok) return res.status(404).json({ error: 'Not found' });

    // One qualifying-party check gates both the external count and the reward evidence.
    const viewerId = String(principal.id);
    if (
      String(artifact.ownerId) !== viewerId &&
      (await hasQualifyingSocialParty(String(artifact.ownerId), [viewerId]))
    ) {
      await PublishedArtifact.updateOne({ publicId: artifact.publicId }, { $inc: { externalViewCount: 1 } });
      await recordVerifiedView(artifact, viewerId, true);
    }
    return res.status(204).end();
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

import { baseApi } from '@server/middlewares/baseApi';
import { optionalJwtAuth } from '@server/middlewares/optionalJwtAuth';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { z } from 'zod';
import { PublishedArtifact, shareTokenFilter } from '@bike4mind/database';
import { checkShareGrant, checkVisibility, toPublishUser } from '@server/services/publish';
import { parsePublishPath, segmentsFromViewerPathname } from '@server/services/publish/parsePublishPath';
import { requestHasGateProof } from '@server/services/publish/publishGateToken';
import type { PublishVisibility } from '@bike4mind/common';

/**
 * POST /api/publish/view - record a signed-in, non-owner view of a published bundle, the
 * condition the Published gear's payout waits on (`externalViewCount`, see
 * server/services/gears/catalog.ts).
 *
 * The serve route can only count a view whose REQUEST identifies the viewer, and a top-level
 * navigation to /p/... or /a/... carries no Authorization header. So on an open-public page or
 * an open share link - the common way to share - the serve route sees every viewer as
 * anonymous, and must (anonymous views cannot be told apart from the owner's own; see
 * bumpViewCount in serve/[...path].ts). The wrapper widget closes that gap: when this browser
 * holds a session it exchanges the refresh cookie for a token and calls this route once,
 * so the viewer is identified the same way the comment overlay identifies them.
 *
 * Grants nothing a second account could not already get from the serve route itself (a
 * Bearer/X-API-Key request there counts too). Only `externalViewCount` moves: the navigation
 * already counted the view in `viewCount`. Gated pages are not double-counted: their wrapper is
 * reached through the loader shell, whose authenticated `?raw=1` fetch counts the view and
 * which never loads the widget.
 */

const BodySchema = z.object({
  /** Browser location.pathname of the viewer page: /p/..., /uc/..., or /a/<token>. */
  path: z.string().min(3).max(512),
});

type ViewLean = {
  publicId: string;
  ownerId: string;
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
      .select('publicId ownerId scopeId visibility accessGate.kind accessGate.allowedDomains')
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

    // The owner opening their own page is the self-grant this whole rule exists to refuse.
    if (String(artifact.ownerId) !== String(principal.id)) {
      await PublishedArtifact.updateOne({ publicId: artifact.publicId }, { $inc: { externalViewCount: 1 } });
    }
    return res.status(204).end();
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

import { baseApi } from '@server/middlewares/baseApi';
import { optionalAuth } from '@server/middlewares/optionalAuth';
import { rateLimit } from '@server/middlewares/rateLimit';
import { z } from 'zod';
import { PublishedArtifact } from '@bike4mind/database';
import { parsePublishPath, segmentsFromViewerPathname } from '@server/services/publish/parsePublishPath';
import { setGateProofCookie } from '@server/services/publish/publishGateToken';

/**
 * POST /api/publish/gate/owner - mint the passphrase proof cookie for a viewer the gate would
 * already admit on identity alone: the artifact's owner, or an admin.
 *
 * This grants NO new authority. checkAccessGate has always let those two through ahead of any
 * proof check ("Owner/admin never gate themselves out of their own artifact"), but that bypass
 * is guarded on `user?.id` and a top-level navigation to /p/... carries no Authorization header,
 * so it could never fire on the one path that matters - and the owner was asked for the
 * passphrase they set themselves. The prompt shell calls this with a recovered access token and
 * reloads on 204, after which the normal serve path renders the artifact with its normal CSP
 * and wrapper. Minting the cookie rather than rendering in place is what keeps this change out
 * of the viewer pipeline entirely.
 *
 * Deliberately a SEPARATE route from gate/passphrase: that endpoint is anonymous by design and
 * carries the brute-force controls (per-IP rate limit + per-artifact lockout) that bound
 * guessing. Owner admission is a different question with a different answer, and folding it in
 * would entangle the two.
 */

const BodySchema = z.object({
  /** Browser location.pathname of the viewer page: /p/..., /uc/..., or /a/<token>. */
  path: z.string().min(3).max(512),
});

type GatedLean = {
  publicId: string;
  ownerId: string;
  accessGate?: { kind: 'passphrase' | 'domain' } | null;
} | null;

const handler = baseApi({ auth: false })
  .use(optionalAuth)
  // Abuse bound only - a caller who is not the owner learns nothing and gets nothing. Generous
  // because a legitimate owner may open several of their own artifacts in quick succession.
  .use(rateLimit({ limit: 60, windowMs: 60_000, bucket: 'publish-gate-owner' }))
  .post(async (req, res) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });

    // No credential -> nothing to check. The prompt shell treats this as "show the form",
    // which is the right destination for every anonymous viewer.
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });

    const segments = segmentsFromViewerPathname(parsed.data.path);
    const resolved = segments ? parsePublishPath(segments) : null;
    if (!resolved) return res.status(404).json({ error: 'Not found' });

    const query =
      resolved.kind === 'bundle'
        ? { tier: resolved.tier, scopeId: resolved.scopeId, slug: resolved.slug, deletedAt: null }
        : resolved.kind === 'share'
          ? { shareToken: resolved.shareToken, deletedAt: null }
          : { publicId: resolved.publicId, 'source.kind': resolved.kind, deletedAt: null };

    // Only the gate KIND is needed - never the hash. This route does not compare a passphrase,
    // so it has no business loading one (passphraseHash stays select:false and unread here).
    const artifact = await PublishedArtifact.findOne(query)
      .select('publicId ownerId accessGate.kind')
      .lean<GatedLean>();

    // Terse, and identical in shape to the anonymous route: an unknown or ungated artifact is
    // simply not found, so this endpoint confirms nothing a caller could not learn from the URL.
    if (!artifact || artifact.accessGate?.kind !== 'passphrase') {
      return res.status(404).json({ error: 'Not found' });
    }

    const isOwner = String(artifact.ownerId) === String(req.user.id);
    if (!isOwner && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Passphrase required' });
    }

    if (!setGateProofCookie(res, artifact.publicId)) {
      // publicId failed the cookie-name safety check - treat as unservable.
      return res.status(500).json({ error: 'Unable to grant access' });
    }
    return res.status(204).end();
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

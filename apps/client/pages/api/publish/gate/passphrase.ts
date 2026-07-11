import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { PublishedArtifact } from '@bike4mind/database';
import { parsePublishPath, segmentsFromViewerPathname } from '@server/services/publish/parsePublishPath';
import { setGateProofCookie } from '@server/services/publish/publishGateToken';

/**
 * POST /api/publish/gate/passphrase - verify a passphrase for a gated published
 * artifact (issue #383) and mint the HttpOnly proof cookie the serve route's
 * visibility gate accepts. Called by the static prompt shell
 * (renderPassphraseShell) with the viewer pathname + entered passphrase.
 *
 * Anonymous by design (the whole point is viewers without accounts). Brute force
 * is bounded by the per-IP rate limit below; responses are deliberately terse
 * (404 unknown/ungated, 403 wrong passphrase) so the endpoint confirms nothing
 * an anonymous caller couldn't learn from the viewer URL itself.
 */

const BodySchema = z.object({
  /** Browser location.pathname of the viewer page: /p/..., /uc/..., or /a/<token>. */
  path: z.string().min(3).max(512),
  passphrase: z.string().min(1).max(128),
});

type GatedLean = {
  publicId: string;
  accessGate?: { kind: 'passphrase' | 'domain'; passphraseHash?: string | null } | null;
} | null;

const handler = baseApi({ auth: false })
  // 10 attempts / 5 min / IP across ALL gated artifacts (stable bucket - the
  // route is static so pathname keying is already stable, but be explicit).
  .use(rateLimit({ limit: 10, windowMs: 5 * 60_000, bucket: 'publish-gate-passphrase' }))
  .post(async (req, res) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    const segments = segmentsFromViewerPathname(parsed.data.path);
    const resolved = segments ? parsePublishPath(segments) : null;
    if (!resolved) {
      return res.status(404).json({ error: 'Not found' });
    }

    // The passphrase hash is select:false on the schema; opt in explicitly here
    // (the ONLY read path that ever loads it).
    const query =
      resolved.kind === 'bundle'
        ? { tier: resolved.tier, scopeId: resolved.scopeId, slug: resolved.slug, deletedAt: null }
        : resolved.kind === 'share'
          ? { shareToken: resolved.shareToken, deletedAt: null }
          : { publicId: resolved.publicId, 'source.kind': resolved.kind, deletedAt: null };
    // Project LEAF sub-paths only, never the parent `accessGate` together with a
    // child - MongoDB rejects `{ accessGate: 1, 'accessGate.passphraseHash': 1 }`
    // with a path-collision error (500 on every call, so no passphrase gate could
    // ever be unlocked). passphraseHash is select:false, hence the leading `+`.
    const artifact = await PublishedArtifact.findOne(query)
      .select('publicId accessGate.kind +accessGate.passphraseHash')
      .lean<GatedLean>();

    if (!artifact || artifact.accessGate?.kind !== 'passphrase' || !artifact.accessGate.passphraseHash) {
      return res.status(404).json({ error: 'Not found' });
    }

    const ok = await bcrypt.compare(parsed.data.passphrase, artifact.accessGate.passphraseHash);
    if (!ok) {
      return res.status(403).json({ error: 'Incorrect passphrase' });
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

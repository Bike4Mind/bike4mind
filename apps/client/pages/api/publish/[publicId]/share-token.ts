import { baseApi } from '@server/middlewares/baseApi';
import { PublishedArtifact } from '@bike4mind/database';
import { generateShareToken } from '@server/services/publish';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import * as z from 'zod';

const shareTokenBodySchema = z.object({
  regenerate: z.boolean().optional(),
});

/**
 * Owner-only management of a published artifact's no-sign-in share token (the
 * capability behind `/a/<shareToken>`).
 *
 *   GET    - report whether a link is live, WITHOUT minting one, so the owner-facing
 *          surface can offer Revoke on a cold page load. Returns the token
 *          itself: the caller is the owner, who may already hold it.
 *   POST   { regenerate?: boolean } - mint the token if absent (idempotent);
 *          `regenerate: true` rotates it, which instantly revokes every
 *          outstanding `/a` link WITHOUT touching the artifact or its `/p/*` URL.
 *   DELETE - revoke: drop the token so all `/a` links 404 immediately. Refused while
 *          a non-public artifact carries an access gate, because the token is then the
 *          gate's only enforcing surface (see GATE_REQUIRES_ENFORCING_SURFACE in
 *          `artifacts/[id].ts` - these two must stay in sync).
 *
 * Share links are served `no-store`, so no CDN invalidation is needed on rotate/
 * revoke. The token value is never logged.
 */

interface ShareTokenArtifactLean {
  publicId: string;
  ownerId: string;
  shareToken?: string;
  shareTokenUpdatedAt?: Date | null;
  visibility?: string;
  accessGate?: unknown;
}

async function loadOwnedArtifact(req: Request, res: Response): Promise<ShareTokenArtifactLean | null> {
  if (!req.user?.id) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  const publicId = String((req.query as { publicId?: string }).publicId ?? '');
  if (!publicId) {
    res.status(400).json({ error: 'Missing publicId' });
    return null;
  }
  const artifact = await PublishedArtifact.findOne({ publicId, deletedAt: null }).lean<ShareTokenArtifactLean>();
  if (!artifact) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  if (artifact.ownerId !== String(req.user.id) && !req.user.isAdmin) {
    res.status(403).json({ error: 'Only the owner may manage this share link' });
    return null;
  }
  return artifact;
}

const handler = baseApi()
  .get(async (req: Request, res: Response) => {
    // The body carries the capability token itself, so it must never sit in a shared
    // cache. Set before the gate so the 400/401/403/404 bodies are covered too (same
    // placement and reason as annotations/[publicId]/can-comment.ts).
    res.setHeader('Cache-Control', 'private, no-store');

    const artifact = await loadOwnedArtifact(req, res);
    if (!artifact) return;

    // Read-only: never mints. `hasShareToken` is what drives the owner's controls, so a
    // surface can render Copy/Regenerate/Revoke on first paint instead of having to POST
    // (which would mint a link merely by looking).
    return res.status(200).json({
      hasShareToken: Boolean(artifact.shareToken),
      shareToken: artifact.shareToken ?? null,
      shareUrl: artifact.shareToken ? `/a/${artifact.shareToken}` : null,
      shareTokenUpdatedAt: artifact.shareTokenUpdatedAt ?? null,
    });
  })
  .post(async (req: Request, res: Response) => {
    const artifact = await loadOwnedArtifact(req, res);
    if (!artifact) return;

    const regenerate = shareTokenBodySchema.parse(req.body ?? {}).regenerate === true;

    // Fast path: a token exists and we're not rotating -> return it (idempotent).
    if (!regenerate && artifact.shareToken) {
      return res.status(200).json({ shareToken: artifact.shareToken, shareUrl: `/a/${artifact.shareToken}` });
    }

    // Mint or rotate under a compare-and-set so two racing POSTs can't hand a caller a
    // token that loses the write race (which would 404). The filter pins the precondition
    // - token ABSENT for a mint, or the EXACT current token for a rotate - so only one
    // racer's write lands; the loser's filter no longer matches and we return the token
    // that actually persisted. (256-bit, so a partial-unique-index collision is negligible.)
    const candidate = generateShareToken();
    const precondition = regenerate
      ? { shareToken: artifact.shareToken ?? { $exists: false } }
      : { shareToken: { $exists: false } };
    const now = new Date();
    const won = await PublishedArtifact.findOneAndUpdate(
      { publicId: artifact.publicId, deletedAt: null, ...precondition },
      // The scalar stays the race arbiter through the rollout (#3255 step 1) and the array is
      // mirrored in the SAME write, so only the racer whose compare-and-set lands appends, and
      // the two shapes cannot diverge. A rotate marks the outgoing entry revoked rather than
      // dropping it, so the token can never be re-minted and its view count survives.
      //
      // An aggregation pipeline rather than $push + $set: revoking the outgoing entry and
      // appending the new one both touch `shareTokens`, which a plain update rejects as a
      // conflicting path. Splitting them into two writes is not an option either - a crash
      // between them would leave the rotated-away token still live in the array, i.e. a
      // revoked link that keeps working. `_id` is generated here because a pipeline update
      // bypasses Mongoose casting and would otherwise leave the entry without the very handle
      // the owner UI revokes by.
      [
        {
          $set: {
            shareToken: candidate,
            shareTokenUpdatedAt: now,
            shareTokens: {
              $concatArrays: [
                regenerate && artifact.shareToken
                  ? {
                      $map: {
                        input: { $ifNull: ['$shareTokens', []] },
                        as: 'entry',
                        in: {
                          $cond: [
                            { $eq: ['$$entry.token', artifact.shareToken] },
                            { $mergeObjects: ['$$entry', { revokedAt: now }] },
                            '$$entry',
                          ],
                        },
                      },
                    }
                  : { $ifNull: ['$shareTokens', []] },
                [{ _id: new Types.ObjectId(), token: candidate, createdAt: now, revokedAt: null, viewCount: 0 }],
              ],
            },
          },
        },
      ],
      { new: true }
    ).lean<{ shareToken?: string }>();

    if (won) {
      req.logger.info(
        `[PUBLISH] share-token ${artifact.shareToken ? 'rotated' : 'minted'} publicId=${artifact.publicId} by=${req.user!.id}`
      );
      return res.status(200).json({ shareToken: candidate, shareUrl: `/a/${candidate}` });
    }

    // Lost the race: a concurrent request already minted/rotated. Return the persisted token.
    const current = await PublishedArtifact.findOne({ publicId: artifact.publicId, deletedAt: null })
      .select('shareToken')
      .lean<{ shareToken?: string }>();
    const token = current?.shareToken ?? candidate;
    return res.status(200).json({ shareToken: token, shareUrl: `/a/${token}` });
  })
  .delete(async (req: Request, res: Response) => {
    const artifact = await loadOwnedArtifact(req, res);
    if (!artifact) return;

    // A gate on a non-public artifact is enforced ONLY through `/a/<token>`
    // (checkShareGrant). Revoking the token here would leave a stored gate that nothing
    // can honor - the exact state the PATCH handler refuses to create. Fail loud and let
    // the owner decide, rather than silently dropping a gate they set.
    if (artifact.shareToken && artifact.accessGate && artifact.visibility !== 'public') {
      return res.status(400).json({
        error:
          "This share link is the only thing enforcing the artifact's access gate - clear the gate or set visibility to public before revoking the link",
        code: 'REVOKE_WOULD_ORPHAN_GATE',
      });
    }

    if (artifact.shareToken) {
      // Mirrors the scalar unset onto every live entry (#3255 step 1). Stamped rather than
      // pulled, so the token stays claimed in the unique index and its view count survives.
      // `arrayFilters` is safe here where it was not on the mint path: nothing is appended in
      // this write, so there is no conflicting update to `shareTokens` itself.
      await PublishedArtifact.updateOne(
        { publicId: artifact.publicId, deletedAt: null },
        {
          $unset: { shareToken: '' },
          $set: { shareTokenUpdatedAt: null, 'shareTokens.$[live].revokedAt': new Date() },
        },
        { arrayFilters: [{ 'live.revokedAt': null }] }
      );
      req.logger.info(`[PUBLISH] share-token revoked publicId=${artifact.publicId} by=${req.user!.id}`);
    }
    return res.status(200).json({ revoked: true });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

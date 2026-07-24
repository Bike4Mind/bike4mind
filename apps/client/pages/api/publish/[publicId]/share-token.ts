import { baseApi } from '@server/middlewares/baseApi';
import { PublishedArtifact } from '@bike4mind/database';
import { generateShareToken } from '@server/services/publish';
import type { Request, Response } from 'express';
import * as z from 'zod';

const shareTokenBodySchema = z.object({
  regenerate: z.boolean().optional(),
});

/**
 * Owner-only management of a published artifact's no-sign-in share token (the
 * capability behind `/a/<shareToken>`).
 *
 *   POST   { regenerate?: boolean } - mint the token if absent (idempotent);
 *          `regenerate: true` rotates it, which instantly revokes every
 *          outstanding `/a` link WITHOUT touching the artifact or its `/p/*` URL.
 *   DELETE - revoke: drop the token so all `/a` links 404 immediately.
 *
 * Share links are served `no-store`, so no CDN invalidation is needed on rotate/
 * revoke. The token value is never logged.
 */

interface ShareTokenArtifactLean {
  publicId: string;
  ownerId: string;
  shareToken?: string;
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
  .post(async (req: Request, res: Response) => {
    const artifact = await loadOwnedArtifact(req, res);
    if (!artifact) return;

    const regenerate = shareTokenBodySchema.parse(req.body).regenerate === true;

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
    const won = await PublishedArtifact.findOneAndUpdate(
      { publicId: artifact.publicId, deletedAt: null, ...precondition },
      { $set: { shareToken: candidate, shareTokenUpdatedAt: new Date() } },
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

    if (artifact.shareToken) {
      await PublishedArtifact.updateOne(
        { publicId: artifact.publicId, deletedAt: null },
        { $unset: { shareToken: '' }, $set: { shareTokenUpdatedAt: null } }
      );
      req.logger.info(`[PUBLISH] share-token revoked publicId=${artifact.publicId} by=${req.user!.id}`);
    }
    return res.status(200).json({ revoked: true });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

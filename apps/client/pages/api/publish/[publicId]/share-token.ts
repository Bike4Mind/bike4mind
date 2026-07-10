import { baseApi } from '@server/middlewares/baseApi';
import { PublishedArtifact } from '@bike4mind/database';
import { generateShareToken } from '@server/services/publish';
import type { Request, Response } from 'express';

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

    const regenerate = (req.body as { regenerate?: boolean } | undefined)?.regenerate === true;
    let shareToken = artifact.shareToken;
    if (regenerate || !shareToken) {
      // 256-bit token, so a collision on the partial-unique index is negligible.
      shareToken = generateShareToken();
      await PublishedArtifact.updateOne(
        { publicId: artifact.publicId, deletedAt: null },
        { $set: { shareToken, shareTokenUpdatedAt: new Date() } }
      );
      req.logger.info(
        `[PUBLISH] share-token ${artifact.shareToken ? 'rotated' : 'minted'} publicId=${artifact.publicId} by=${req.user!.id}`
      );
    }
    return res.status(200).json({ shareToken, shareUrl: `/a/${shareToken}` });
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

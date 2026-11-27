import { baseApi } from '@server/middlewares/baseApi';
import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { PublishServiceError } from '@server/services/publish/publishServiceError';
import { createShareLink, listShareLinks, newestShareLink, revokeShareLink } from '@server/services/publish/shareLinks';
import type { Request, Response } from 'express';

export { MAX_LIVE_SHARE_LINKS, MAX_SHARE_TOKEN_ENTRIES } from '@server/services/publish/shareLinks';

/**
 * Owner-only management of a published artifact's no-sign-in share links (the
 * capability behind `/a/<shareToken>`). The logic lives in `server/services/publish/shareLinks`.
 *
 *   GET    - list the live links, WITHOUT minting one, so the owner-facing surface can
 *          offer Revoke on a cold page load. Returns each token itself: the caller is
 *          the owner, who may already hold them.
 *   POST   { regenerate?, additional?, expiresAt? } - mint a link if none is live (idempotent);
 *          `regenerate: true` rotates, revoking EVERY outstanding link in one write;
 *          `additional: true` mints another link alongside the live ones.
 *   DELETE [?id=<entryId>] - revoke. With an id, revokes that one link; without one,
 *          revokes every live link (what single-link callers expect).
 *
 * Share links are served `no-store`, so no CDN invalidation is needed on rotate/
 * revoke. `shareTokenUpdatedAt` is a GET response field only, derived from the newest live
 * entry's `createdAt` (a documented field with external consumers).
 */

/** Re-shapes a service refusal into this route's `{ error, code? }` body. */
function sendLegacyError(res: Response, error: unknown): Response {
  if (!(error instanceof PublishServiceError)) throw error;
  return res.status(error.statusCode).json({ error: error.message, code: error.errorCode });
}

function actor(req: Request, res: Response) {
  if (!req.user?.id) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return {
    user: { id: String(req.user.id), isAdmin: req.user.isAdmin },
    logger: req.logger,
    publicId: String((req.query as { publicId?: string }).publicId ?? ''),
  };
}

const handler = baseApi()
  .get(async (req: Request, res: Response) => {
    // The body carries the capability tokens themselves, so it must never sit in a shared
    // cache. Set before the gate so the 400/401/403/404 bodies are covered too (same
    // placement and reason as annotations/[publicId]/can-comment.ts).
    res.setHeader('Cache-Control', 'private, no-store');

    const input = actor(req, res);
    if (!input) return;
    try {
      // Read-only: never mints. `shareLinks` drives the owner's list; the four single-link
      // fields beside it are what the shipped single-link owner UI reads, kept so this response does not
      // break on deploy. Both describe the same links.
      const shareLinks = await listShareLinks(input);
      const newest = newestShareLink(shareLinks);
      return res.status(200).json({
        hasShareToken: Boolean(newest),
        shareToken: newest?.shareToken ?? null,
        shareUrl: newest?.shareUrl ?? null,
        // Derived from the newest live entry; null with nothing live.
        shareTokenUpdatedAt: newest?.createdAt ?? null,
        shareLinks,
      });
    } catch (error) {
      return sendLegacyError(res, error);
    }
  })
  .post(outboundActionGate(), async (req: Request, res: Response) => {
    const input = actor(req, res);
    if (!input) return;
    try {
      const created = await createShareLink({ ...input, body: req.body ?? {} });
      return res.status(200).json({
        id: created.id,
        shareToken: created.shareToken,
        shareUrl: created.shareUrl,
        shareLinks: created.shareLinks,
      });
    } catch (error) {
      return sendLegacyError(res, error);
    }
  })
  .delete(async (req: Request, res: Response) => {
    const input = actor(req, res);
    if (!input) return;
    try {
      // A blank id keeps meaning revoke-all here; a repeated id is coerced to a string the service rejects as invalid.
      const id = String((req.query as { id?: string }).id ?? '').trim();
      const result = await revokeShareLink({ ...input, id: id || undefined });
      return res.status(200).json(result);
    } catch (error) {
      return sendLegacyError(res, error);
    }
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

import { baseApi } from '@server/middlewares/baseApi';
import { PublishedArtifact, liveShareTokens, type PublishedArtifactShareToken } from '@bike4mind/database';
import { generateShareToken } from '@server/services/publish';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import * as z from 'zod';

const shareTokenBodySchema = z.object({
  regenerate: z.boolean().optional(),
  additional: z.boolean().optional(),
});

/**
 * Owner-only management of a published artifact's no-sign-in share links (the
 * capability behind `/a/<shareToken>`).
 *
 *   GET    - list the live links, WITHOUT minting one, so the owner-facing surface can
 *          offer Revoke on a cold page load. Returns each token itself: the caller is
 *          the owner, who may already hold them.
 *   POST   { regenerate?, additional? } - mint a link if none is live (idempotent);
 *          `regenerate: true` rotates, revoking EVERY outstanding link in one write;
 *          `additional: true` mints another link alongside the live ones.
 *   DELETE [?id=<entryId>] - revoke. With an id, revokes that one link; without one,
 *          revokes every live link (what the pre-#3255 single-link callers expect).
 *
 * Share links are served `no-store`, so no CDN invalidation is needed on rotate/
 * revoke. The token value is never logged.
 *
 * #3255 step 3: `shareTokens[]` is now the source of truth and the race arbiter - every
 * precondition below pins an entry's liveness, not the legacy scalar. `shareToken` /
 * `shareTokenUpdatedAt` are still WRITTEN, mirrored to the newest live entry, so a
 * rollback to a build that reads the scalar still serves a link. Retiring them is a
 * follow-up, not this change. Do not read them here - use `liveShareTokens()`.
 */

/** Ceiling on live links per artifact. Not a security boundary (the owner can revoke and
 *  mint freely); it stops a stuck client from growing the subdocument array without bound,
 *  and keeps the owner's list a list rather than a scroll. */
const MAX_LIVE_SHARE_LINKS = 20;

interface ShareTokenArtifactLean {
  publicId: string;
  ownerId: string;
  shareToken?: string;
  shareTokenUpdatedAt?: Date | null;
  shareTokens?: PublishedArtifactShareToken[];
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

/** One live link as the owner surface renders it. `id` is null only for a row the backfill
 *  has not reached, whose single link exists as the legacy scalar and so has no entry handle
 *  to revoke by - such a link is still revocable through the id-less DELETE. */
interface ShareLinkView {
  id: string | null;
  shareToken: string;
  shareUrl: string;
  createdAt: Date | null;
  viewCount: number;
  lastViewedAt: Date | null;
}

function toShareLinkView(entry: PublishedArtifactShareToken): ShareLinkView {
  return {
    id: entry._id ? String(entry._id) : null,
    shareToken: entry.token!,
    shareUrl: `/a/${entry.token}`,
    createdAt: entry.createdAt ?? null,
    viewCount: entry.viewCount ?? 0,
    lastViewedAt: entry.lastViewedAt ?? null,
  };
}

/** The live links, in `liveShareTokens` order (a legacy scalar-only link first, then the
 *  array entries oldest-first as they were appended). */
function liveLinkViews(artifact: ShareTokenArtifactLean): ShareLinkView[] {
  return liveShareTokens(artifact).map(toShareLinkView);
}

/** The link the single-link response fields describe: the newest live one. Everything a
 *  pre-#3255 caller reads (`shareToken`, `shareUrl`, `hasShareToken`) is derived from this,
 *  which is also what the mirrored scalar holds. */
function newestLive(links: ShareLinkView[]): ShareLinkView | undefined {
  return links[links.length - 1];
}

/** Matches an entry that is live, tolerating `revokedAt` being absent rather than null.
 *  Mirrors `liveShareTokens`'s `!entry.revokedAt`. */
const IS_LIVE = { $eq: [{ $ifNull: ['$$entry.revokedAt', null] }, null] };

/** Pipeline stages that stamp `revokedAt` on every live entry matching `target`, then
 *  re-derive the mirrored scalar from whatever is still live. Shared by both revoke paths so
 *  the mirror cannot drift between them: `shareToken` ends as the newest surviving token, or
 *  is removed outright when the last link goes. */
function revokeStages(target: Record<string, unknown>, now: Date): Record<string, unknown>[] {
  return [
    {
      $set: {
        shareTokens: {
          $map: {
            input: { $ifNull: ['$shareTokens', []] },
            as: 'entry',
            in: {
              $cond: [{ $and: [IS_LIVE, target] }, { $mergeObjects: ['$$entry', { revokedAt: now }] }, '$$entry'],
            },
          },
        },
      },
    },
    {
      // Its own stage because it reads the $map's output: a single $set sees the pre-update
      // document for every path it references.
      $set: {
        __live: {
          $filter: {
            input: '$shareTokens',
            as: 'entry',
            cond: { $and: [IS_LIVE, { $eq: [{ $type: '$$entry.token' }, 'string'] }] },
          },
        },
      },
    },
    {
      $set: {
        shareToken: { $ifNull: [{ $last: '$__live.token' }, '$$REMOVE'] },
        // Derived from the SAME survivor as the token, not carried over: after revoking the
        // newest of several links the scalar moves to an older one, and a carried-over
        // timestamp would then describe the link that was just revoked.
        shareTokenUpdatedAt: { $ifNull: [{ $last: '$__live.createdAt' }, null] },
      },
    },
    { $unset: '__live' },
  ];
}

const handler = baseApi()
  .get(async (req: Request, res: Response) => {
    // The body carries the capability tokens themselves, so it must never sit in a shared
    // cache. Set before the gate so the 400/401/403/404 bodies are covered too (same
    // placement and reason as annotations/[publicId]/can-comment.ts).
    res.setHeader('Cache-Control', 'private, no-store');

    const artifact = await loadOwnedArtifact(req, res);
    if (!artifact) return;

    // Read-only: never mints. `shareLinks` drives the owner's list; the four single-link
    // fields beside it are what the shipped single-link owner UI reads, kept so this response does not
    // break on deploy. Both describe the same links.
    const shareLinks = liveLinkViews(artifact);
    const newest = newestLive(shareLinks);
    return res.status(200).json({
      hasShareToken: Boolean(newest),
      shareToken: newest?.shareToken ?? null,
      shareUrl: newest?.shareUrl ?? null,
      shareTokenUpdatedAt: artifact.shareTokenUpdatedAt ?? null,
      shareLinks,
    });
  })
  .post(async (req: Request, res: Response) => {
    const artifact = await loadOwnedArtifact(req, res);
    if (!artifact) return;

    const parsed = shareTokenBodySchema.parse(req.body ?? {});
    const regenerate = parsed.regenerate === true;
    const additional = parsed.additional === true;
    if (regenerate && additional) {
      return res.status(400).json({
        error: 'regenerate and additional are mutually exclusive - rotating revokes the links that additional adds to',
        code: 'CONFLICTING_MINT_MODE',
      });
    }

    const live = liveLinkViews(artifact);

    // Fast path: a link is live and we are neither rotating nor adding -> return it (idempotent).
    if (!regenerate && !additional && live.length) {
      const newest = newestLive(live)!;
      return res
        .status(200)
        .json({ id: newest.id, shareToken: newest.shareToken, shareUrl: newest.shareUrl, shareLinks: live });
    }

    if (additional && live.length >= MAX_LIVE_SHARE_LINKS) {
      return res.status(400).json({
        error: `An artifact may have at most ${MAX_LIVE_SHARE_LINKS} live share links - revoke one before minting another`,
        code: 'SHARE_LINK_LIMIT',
      });
    }

    // Mint, rotate or add under a compare-and-set so two racing POSTs cannot hand a caller a
    // link that loses the write race (which would 404). The precondition pins the ARRAY's
    // liveness, not the legacy scalar (#3255 step 3): "token absent" for a mint is "no live
    // entry", and a rotate pins the exact entry it rotates away from, so only one racer's
    // write lands. `additional` deliberately has no such precondition - adding a link is not
    // idempotent by intent, and the limit above is its only guard.
    // (256-bit tokens, so a partial-unique-index collision is negligible.)
    const candidate = generateShareToken();
    const rotatingFrom = regenerate ? newestLive(live) : undefined;
    // A live link the backfill never mirrored: it exists only as the scalar, which this write
    // is about to overwrite with the new token. `additional` means "keep what is live and add
    // one", so the legacy link is folded into the array in the SAME write rather than being
    // silently killed - every other path here already tolerates such a row, and this makes it
    // self-healing. Its precondition pins the scalar, so a racer that rotated it away first
    // cannot have the entry resurrected underneath them.
    const strandedLegacy = additional ? live.find(link => link.id === null) : undefined;
    const precondition = additional
      ? strandedLegacy
        ? { shareToken: strandedLegacy.shareToken }
        : {}
      : rotatingFrom?.id
        ? { shareTokens: { $elemMatch: { _id: new Types.ObjectId(rotatingFrom.id), revokedAt: null } } }
        : rotatingFrom
          ? // Pre-backfill row: its only link is the scalar, so that is the one thing to pin.
            { shareToken: rotatingFrom.shareToken }
          : { shareTokens: { $not: { $elemMatch: { revokedAt: null } } }, shareToken: { $exists: false } };
    const now = new Date();
    const entryId = new Types.ObjectId();
    const won = await PublishedArtifact.findOneAndUpdate(
      { publicId: artifact.publicId, deletedAt: null, ...precondition },
      // An aggregation pipeline rather than $push + $set: revoking the outgoing entries and
      // appending the new one both touch `shareTokens`, which a plain update rejects as a
      // conflicting path. Splitting them into two writes is not an option either - a crash
      // between them would leave a rotated-away token still live in the array, i.e. a revoked
      // link that keeps working. `_id` is generated here because a pipeline update bypasses
      // Mongoose casting and would otherwise leave the entry without the very handle the owner
      // UI revokes by.
      //
      // A rotate marks EVERY live entry revoked, not just the pinned one: `regenerate: true`
      // has always meant "revoke every outstanding link", and the shipped Replace control still
      // means that. Replacing one link of several is revoke-by-id followed by `additional`.
      [
        {
          $set: {
            shareToken: candidate,
            shareTokenUpdatedAt: now,
            shareTokens: {
              $concatArrays: [
                regenerate
                  ? {
                      $map: {
                        input: { $ifNull: ['$shareTokens', []] },
                        as: 'entry',
                        in: { $cond: [IS_LIVE, { $mergeObjects: ['$$entry', { revokedAt: now }] }, '$$entry'] },
                      },
                    }
                  : { $ifNull: ['$shareTokens', []] },
                // The stranded legacy link, mirrored into the array before the new entry so it
                // keeps resolving through shareTokenFilter once the scalar moves on. Its
                // createdAt is the closest truth the row carries, the same choice the backfill
                // migration made.
                strandedLegacy
                  ? [
                      {
                        _id: new Types.ObjectId(),
                        token: strandedLegacy.shareToken,
                        createdAt: artifact.shareTokenUpdatedAt ?? now,
                        revokedAt: null,
                        viewCount: 0,
                        lastViewedAt: null,
                      },
                    ]
                  : [],
                [{ _id: entryId, token: candidate, createdAt: now, revokedAt: null, viewCount: 0, lastViewedAt: null }],
              ],
            },
          },
        },
      ],
      { new: true }
    ).lean<ShareTokenArtifactLean>();

    if (won) {
      req.logger.info(
        `[PUBLISH] share-token ${regenerate ? 'rotated' : additional ? 'added' : 'minted'} publicId=${artifact.publicId} by=${req.user!.id}`
      );
      return res.status(200).json({
        id: String(entryId),
        shareToken: candidate,
        shareUrl: `/a/${candidate}`,
        shareLinks: liveLinkViews(won),
      });
    }

    // Lost the race: a concurrent request already minted/rotated. Return what persisted.
    const current = await PublishedArtifact.findOne({ publicId: artifact.publicId, deletedAt: null })
      .select('shareToken shareTokens')
      .lean<ShareTokenArtifactLean>();
    const persisted = current ? liveLinkViews(current) : [];
    const newest = newestLive(persisted);
    return res.status(200).json({
      id: newest?.id ?? null,
      shareToken: newest?.shareToken ?? candidate,
      shareUrl: newest?.shareUrl ?? `/a/${candidate}`,
      shareLinks: persisted,
    });
  })
  .delete(async (req: Request, res: Response) => {
    const artifact = await loadOwnedArtifact(req, res);
    if (!artifact) return;

    const id = String((req.query as { id?: string }).id ?? '').trim();
    if (id && !Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid share link id' });
    }
    const live = liveLinkViews(artifact);
    // Resolve the target BEFORE writing. A pipeline that matched nothing would still fall
    // through to the mirror-rebuild stages and, on a pre-backfill row, unset the scalar - so
    // an unknown id would revoke the very link it did not name.
    const target = id ? live.find(link => link.id === id) : undefined;
    if (id && !target) {
      return res.status(404).json({ error: 'No live share link with that id' });
    }
    const revoking = target ? [target] : live;
    const survivors = live.length - revoking.length;

    // A gate on a non-public artifact is enforced ONLY through `/a/<token>`
    // (checkShareGrant). Revoking the LAST live link would leave a stored gate that nothing
    // can honor - the exact state the PATCH handler refuses to create. Fail loud and let the
    // owner decide, rather than silently dropping a gate they set. Revoking one of several is
    // fine: the survivors keep enforcing it. (See GATE_REQUIRES_ENFORCING_SURFACE in
    // `artifacts/[id].ts` - these two must stay in sync.)
    const gateNeedsALink = Boolean(artifact.accessGate) && artifact.visibility !== 'public';
    if (live.length && survivors === 0 && gateNeedsALink) {
      return res.status(400).json({
        error:
          "This share link is the only thing enforcing the artifact's access gate - clear the gate or set visibility to public before revoking the link",
        code: 'REVOKE_WOULD_ORPHAN_GATE',
      });
    }

    if (revoking.length) {
      // Stamped rather than pulled, so each token stays claimed in the unique index (a revoked
      // link can never be re-minted) and its view count survives. The mirrored scalar is
      // re-derived from the survivors in the same write.
      //
      // The survivor requirement has to be part of the FILTER, not just the in-memory check
      // above: that check reads the `loadOwnedArtifact` snapshot, so two concurrent
      // revoke-by-id calls on the last two links each see one survivor, both pass, and between
      // them they orphan the gate the refusal exists to protect. Pinning "some OTHER entry is
      // still live" makes the loser match nothing - the same compare-and-set move the mint and
      // rotate paths make. Only applied when a gate actually needs a link, so an ungated
      // artifact keeps the cheap unconditional filter.
      const pinSurvivor = gateNeedsALink && !!target;
      const survivorPin = pinSurvivor
        ? { shareTokens: { $elemMatch: { _id: { $ne: new Types.ObjectId(target!.id!) }, revokedAt: null } } }
        : {};
      const result = await PublishedArtifact.updateOne(
        { publicId: artifact.publicId, deletedAt: null, ...survivorPin },
        revokeStages(target ? { $eq: ['$$entry._id', new Types.ObjectId(target.id!)] } : { $literal: true }, new Date())
      );
      // Lost that race: the siblings this revoke was counting on are gone, so it would now be
      // dropping the last link. Same refusal as the snapshot check, for the same reason.
      if (pinSurvivor && result?.matchedCount === 0) {
        return res.status(400).json({
          error:
            "This share link is the only thing enforcing the artifact's access gate - clear the gate or set visibility to public before revoking the link",
          code: 'REVOKE_WOULD_ORPHAN_GATE',
        });
      }
      req.logger.info(
        `[PUBLISH] share-token revoked publicId=${artifact.publicId} count=${revoking.length} remaining=${survivors} by=${req.user!.id}`
      );
    }
    return res.status(200).json({ revoked: true, remaining: survivors });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

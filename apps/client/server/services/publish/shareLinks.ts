import {
  PublishedArtifact,
  liveShareTokenMatch,
  liveShareTokens,
  type PublishedArtifactShareToken,
} from '@bike4mind/database';
import { requireEnv } from '@bike4mind/common';
import { Types } from 'mongoose';
import * as z from 'zod';
import { generateShareToken } from '@server/services/publish';
import { assertPublicationPublicLink, type PublicationPolicyContext } from './organizationPolicy';
import { PublishServiceError } from './publishServiceError';

/**
 * Owner-only management of a published artifact's no-sign-in share links (the capability behind
 * `/a/<shareToken>`). `shareTokens[]` is the only representation of a share link and the race
 * arbiter: every precondition below pins an entry's liveness. Views carry full tokens; callers that
 * must not reveal them redact on their side. The token value is never logged.
 */

/** Ceiling on live links per artifact. Not a security boundary (the owner can revoke and
 *  mint freely); it keeps the owner's list a list rather than a scroll. The array as a whole
 *  is bounded by MAX_SHARE_TOKEN_ENTRIES. */
export const MAX_LIVE_SHARE_LINKS = 20;

/** Ceiling on the whole `shareTokens[]` array, revoked and expired entries included. Every mint
 *  prunes the oldest dead entries past it; live entries are never pruned. Kept well above
 *  MAX_LIVE_SHARE_LINKS so a full live set still leaves room for retained revoked entries; at
 *  or below it, a mint would prune every revoked entry. */
export const MAX_SHARE_TOKEN_ENTRIES = 50;

const MAX_SHARE_LINK_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
// A link that expires almost at once stops counting toward MAX_LIVE_SHARE_LINKS, so without a floor
// `additional: true` could append entries as fast as it is called.
const MIN_SHARE_LINK_LIFETIME_MS = 60 * 60 * 1000;
const isoDateTime = z.iso.datetime({ offset: true });

export const shareLinkBodySchema = z.object({
  regenerate: z.boolean().optional(),
  additional: z.boolean().optional(),
  // Validated by `parseShareLinkExpiry` so every bad value gets the same 400 code.
  expiresAt: z.unknown().optional(),
});

export const SHARE_LINK_ERROR_CODES = {
  invalidExpiry: 'INVALID_SHARE_LINK_EXPIRY',
  conflictingMintMode: 'CONFLICTING_MINT_MODE',
  limit: 'SHARE_LINK_LIMIT',
  raced: 'SHARE_LINK_RACED',
  wouldOrphanGate: 'REVOKE_WOULD_ORPHAN_GATE',
} as const;

type ShareLinkLogger = { info: (message: string) => void };

export interface ShareLinkUser {
  id: string;
  isAdmin?: boolean;
}

/** One live link as the owner surface renders it. `id` is the entry `_id` the owner revokes by. */
export interface ShareLinkView {
  id: string;
  shareToken: string;
  /** Relative path (`/a/<token>`); see {@link absoluteShareLinkUrl}. */
  shareUrl: string;
  createdAt: Date | null;
  expiresAt: Date | null;
  viewCount: number;
  lastViewedAt: Date | null;
}

export interface CreateShareLinkResult {
  id: string;
  shareToken: string;
  shareUrl: string;
  expiresAt: Date | null;
  /** Every live link after the call, oldest first. */
  shareLinks: ShareLinkView[];
}

export interface RevokeShareLinkResult {
  revoked: true;
  remaining: number;
}

interface ShareTokenArtifactLean extends PublicationPolicyContext {
  publicId: string;
  ownerId: string;
  shareTokens?: PublishedArtifactShareToken[];
  visibility?: string;
  accessGate?: unknown;
}

/** Joins a view's relative `shareUrl` to the app origin. Throws when APP_URL is unset, so only v1 doors call it. */
export function absoluteShareLinkUrl(shareUrl: string): string {
  return `${requireEnv('APP_URL', process.env.APP_URL).trim().replace(/\/+$/, '')}${shareUrl}`;
}

/** The requested expiry: absent -> null (never expires); otherwise an ISO datetime 1 hour to 365 days away. */
function parseShareLinkExpiry(raw: unknown, now: Date): Date | null | 'invalid' {
  if (raw === undefined) return null;
  if (!isoDateTime.safeParse(raw).success) return 'invalid';
  const expiresAt = new Date(raw as string);
  const ms = expiresAt.getTime() - now.getTime();
  return ms >= MIN_SHARE_LINK_LIFETIME_MS && ms <= MAX_SHARE_LINK_LIFETIME_MS ? expiresAt : 'invalid';
}

async function loadOwnedArtifact(user: ShareLinkUser, publicId: string): Promise<ShareTokenArtifactLean> {
  if (!publicId) throw new PublishServiceError(400, 'Missing publicId');
  const artifact = await PublishedArtifact.findOne({ publicId, deletedAt: null }).lean<ShareTokenArtifactLean>();
  if (!artifact) throw new PublishServiceError(404, 'Not found');
  if (artifact.ownerId !== String(user.id) && !user.isAdmin) {
    throw new PublishServiceError(403, 'Only the owner may manage this share link');
  }
  return artifact;
}

function toShareLinkView(entry: PublishedArtifactShareToken): ShareLinkView {
  return {
    id: String(entry._id),
    shareToken: entry.token!,
    shareUrl: `/a/${entry.token}`,
    createdAt: entry.createdAt ?? null,
    expiresAt: entry.expiresAt ?? null,
    viewCount: entry.viewCount ?? 0,
    lastViewedAt: entry.lastViewedAt ?? null,
  };
}

/** The live links, oldest-first as they were appended (`liveShareTokens` order). */
function liveLinkViews(artifact: ShareTokenArtifactLean, now?: Date): ShareLinkView[] {
  return liveShareTokens(artifact, now).map(toShareLinkView);
}

/** The newest live link, which the legacy single-link response fields describe. */
export function newestShareLink(links: ShareLinkView[]): ShareLinkView | undefined {
  return links[links.length - 1];
}

/** Matches an entry that is live (has a token, not revoked, not expired), tolerating absent
 *  fields. Must stay in sync with `liveShareTokens` in `@bike4mind/database`; `liveShareTokenMatch`
 *  there has no token check and relies on the schema making `token` required. */
function isLive(now: Date): Record<string, unknown> {
  return {
    $and: [
      { $eq: [{ $type: '$$entry.token' }, 'string'] },
      { $ne: ['$$entry.token', ''] },
      { $eq: [{ $ifNull: ['$$entry.revokedAt', null] }, null] },
      {
        $or: [{ $eq: [{ $ifNull: ['$$entry.expiresAt', null] }, null] }, { $gt: ['$$entry.expiresAt', now] }],
      },
    ],
  };
}

/** Live-entry count of `shareTokens`, as an aggregation expression. */
function liveCount(now: Date): Record<string, unknown> {
  return { $size: { $filter: { input: { $ifNull: ['$shareTokens', []] }, as: 'entry', cond: isLive(now) } } };
}

/**
 * Bounds the post-mint array `next` to MAX_SHARE_TOKEN_ENTRIES by dropping its oldest dead
 * entries. Keeps every live entry (even past the cap) and the original order, so the newest
 * live entry stays last.
 */
function capShareTokens(next: unknown, now: Date): Record<string, unknown> {
  const deadRoom = {
    $subtract: [MAX_SHARE_TOKEN_ENTRIES, { $size: { $filter: { input: '$$next', as: 'entry', cond: isLive(now) } } }],
  };
  const deadIds = {
    $map: {
      input: { $filter: { input: '$$next', as: 'entry', cond: { $not: [isLive(now)] } } },
      as: 'entry',
      in: '$$entry._id',
    },
  };
  return {
    $let: {
      vars: { next },
      in: {
        $let: {
          vars: { deadRoom, deadIds },
          in: {
            $let: {
              // $slice rejects a count of 0, hence the guard.
              vars: {
                keptDeadIds: {
                  $cond: [{ $gt: ['$$deadRoom', 0] }, { $slice: ['$$deadIds', { $multiply: ['$$deadRoom', -1] }] }, []],
                },
              },
              in: {
                $filter: {
                  input: '$$next',
                  as: 'entry',
                  cond: { $or: [isLive(now), { $in: ['$$entry._id', '$$keptDeadIds'] }] },
                },
              },
            },
          },
        },
      },
    },
  };
}

/**
 * Pipeline stages that stamp `revokedAt` on every live entry matching `target`.
 *
 * Shared by revoke-by-id and revoke-everything, which differ only in `target`, so they cannot
 * disagree about what "live" means. Stamped rather than pulled - see the call sites for why.
 */
function revokeStages(target: Record<string, unknown>, now: Date): Record<string, unknown>[] {
  return [
    {
      $set: {
        shareTokens: {
          $map: {
            input: { $ifNull: ['$shareTokens', []] },
            as: 'entry',
            in: {
              $cond: [{ $and: [isLive(now), target] }, { $mergeObjects: ['$$entry', { revokedAt: now }] }, '$$entry'],
            },
          },
        },
      },
    },
  ];
}

function limitError(): PublishServiceError {
  return new PublishServiceError(
    400,
    `An artifact may have at most ${MAX_LIVE_SHARE_LINKS} live share links - revoke one before minting another`,
    { errorCode: SHARE_LINK_ERROR_CODES.limit }
  );
}

function racedError(message: string): PublishServiceError {
  return new PublishServiceError(409, message, { errorCode: SHARE_LINK_ERROR_CODES.raced });
}

function orphanGateError(): PublishServiceError {
  return new PublishServiceError(
    400,
    "This share link is the only thing enforcing the artifact's access gate - clear the gate or set visibility to public before revoking the link",
    { errorCode: SHARE_LINK_ERROR_CODES.wouldOrphanGate }
  );
}

function createResult(newest: ShareLinkView, shareLinks: ShareLinkView[]): CreateShareLinkResult {
  return {
    id: newest.id,
    shareToken: newest.shareToken,
    shareUrl: newest.shareUrl,
    expiresAt: newest.expiresAt,
    shareLinks,
  };
}

/** The live links, read-only: never mints. */
export async function listShareLinks(input: {
  user: ShareLinkUser;
  logger: ShareLinkLogger;
  publicId: string;
}): Promise<ShareLinkView[]> {
  const artifact = await loadOwnedArtifact(input.user, input.publicId);
  return liveLinkViews(artifact);
}

export interface CreateShareLinkInput {
  user: ShareLinkUser;
  logger: ShareLinkLogger;
  publicId: string;
  /** Rotate: revoke EVERY outstanding link and mint a new one. */
  regenerate?: boolean;
  /** Mint another link alongside the live ones. Mutually exclusive with `regenerate`. */
  additional?: boolean;
  /** ISO 8601 datetime 1 hour to 365 days away; absent means the link never expires. Validated here. */
  expiresAt?: unknown;
}

/**
 * Mints a link if none is live (idempotent: returns the newest live one), rotates with `regenerate`,
 * or adds with `additional`. Throws a PublishServiceError for 400 (INVALID_SHARE_LINK_EXPIRY,
 * CONFLICTING_MINT_MODE, SHARE_LINK_LIMIT), 409 (SHARE_LINK_RACED), 403 and 404.
 */
export async function createShareLink(input: CreateShareLinkInput): Promise<CreateShareLinkResult> {
  const { user, logger, publicId } = input;
  const artifact = await loadOwnedArtifact(user, publicId);
  await assertPublicationPublicLink(artifact);

  const regenerate = input.regenerate === true;
  const additional = input.additional === true;
  const now = new Date();
  const expiresAt = parseShareLinkExpiry(input.expiresAt, now);
  if (expiresAt === 'invalid') {
    throw new PublishServiceError(
      400,
      'expiresAt must be an ISO 8601 datetime at least 1 hour and at most 365 days away',
      { errorCode: SHARE_LINK_ERROR_CODES.invalidExpiry }
    );
  }
  if (regenerate && additional) {
    throw new PublishServiceError(
      400,
      'regenerate and additional are mutually exclusive - rotating revokes the links that additional adds to',
      { errorCode: SHARE_LINK_ERROR_CODES.conflictingMintMode }
    );
  }

  const live = liveLinkViews(artifact, now);

  // Fast path: a link is live and we are neither rotating nor adding -> return it (idempotent).
  if (!regenerate && !additional && live.length) return createResult(newestShareLink(live)!, live);

  if (additional && live.length >= MAX_LIVE_SHARE_LINKS) throw limitError();

  // Mint, rotate or add under a compare-and-set so two racing calls cannot hand a caller a
  // link that loses the write race (which would 404). A mint requires "no live entry" and a
  // rotate pins the exact entry it rotates away from, so only one racer's write lands.
  // `additional` is not idempotent by intent, so it pins only the live-link limit: the check
  // above reads a snapshot, and concurrent adds would otherwise each pass it.
  // (256-bit tokens, so a partial-unique-index collision is negligible.)
  const candidate = generateShareToken();
  const rotatingFrom = regenerate ? newestShareLink(live) : undefined;
  const precondition = additional
    ? { $expr: { $lt: [liveCount(now), MAX_LIVE_SHARE_LINKS] } }
    : rotatingFrom
      ? { shareTokens: { $elemMatch: { _id: new Types.ObjectId(rotatingFrom.id), ...liveShareTokenMatch(now) } } }
      : { shareTokens: { $not: { $elemMatch: liveShareTokenMatch(now) } } };
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
    //
    // The same write prunes the oldest dead entries past MAX_SHARE_TOKEN_ENTRIES, so repeated
    // rotate or revoke+add cycles cannot grow the array without bound.
    [
      {
        $set: {
          shareTokens: capShareTokens(
            {
              $concatArrays: [
                regenerate
                  ? {
                      $map: {
                        input: { $ifNull: ['$shareTokens', []] },
                        as: 'entry',
                        in: { $cond: [isLive(now), { $mergeObjects: ['$$entry', { revokedAt: now }] }, '$$entry'] },
                      },
                    }
                  : { $ifNull: ['$shareTokens', []] },
                [
                  {
                    _id: entryId,
                    token: candidate,
                    createdAt: now,
                    revokedAt: null,
                    expiresAt,
                    viewCount: 0,
                    lastViewedAt: null,
                  },
                ],
              ],
            },
            now
          ),
        },
      },
    ],
    { new: true }
  ).lean<ShareTokenArtifactLean>();

  if (won) {
    logger.info(
      `[PUBLISH] share-token ${regenerate ? 'rotated' : additional ? 'added' : 'minted'} publicId=${artifact.publicId} by=${user.id}`
    );
    return createResult(
      {
        id: String(entryId),
        shareToken: candidate,
        shareUrl: `/a/${candidate}`,
        createdAt: now,
        expiresAt,
        viewCount: 0,
        lastViewedAt: null,
      },
      liveLinkViews(won)
    );
  }

  // Lost the race: a concurrent request already minted/rotated/added. An additional mint
  // reports why it failed; otherwise return what persisted unless it no longer fits the request.
  const current = await PublishedArtifact.findOne({ publicId: artifact.publicId, deletedAt: null })
    .select('shareTokens')
    .lean<ShareTokenArtifactLean>();
  if (!current) throw new PublishServiceError(404, 'Not found');
  if (additional) {
    if (liveLinkViews(current).length >= MAX_LIVE_SHARE_LINKS) throw limitError();
    throw racedError('The share links changed while adding one - try again');
  }
  const persisted = liveLinkViews(current);
  const newest = newestShareLink(persisted);
  // Compared by token: it is what a holder possesses.
  const before = new Set(live.map(l => l.shareToken));
  if (regenerate && persisted.some(l => before.has(l.shareToken))) {
    throw racedError('The share links changed while rotating - try again');
  }
  if (!newest) throw racedError('The share link was revoked while it was being created - try again');
  return createResult(newest, persisted);
}

/**
 * Revokes one live link (`id`) or, without an id, every live link. Throws a PublishServiceError for
 * 400 (invalid id, REVOKE_WOULD_ORPHAN_GATE), 403 and 404 (unknown id).
 */
export async function revokeShareLink(input: {
  user: ShareLinkUser;
  logger: ShareLinkLogger;
  publicId: string;
  id?: string;
}): Promise<RevokeShareLinkResult> {
  const { user, logger } = input;
  const artifact = await loadOwnedArtifact(user, input.publicId);

  const id = (input.id ?? '').trim();
  if (id && !Types.ObjectId.isValid(id)) throw new PublishServiceError(400, 'Invalid share link id');
  const live = liveLinkViews(artifact);
  // Resolve the target BEFORE writing, so an unknown id is a 404 rather than a write that
  // matches no entry and reports success.
  const target = id ? live.find(link => link.id === id) : undefined;
  if (id && !target) throw new PublishServiceError(404, 'No live share link with that id');
  const revoking = target ? [target] : live;
  const survivors = live.length - revoking.length;

  // A gate on a non-public artifact is enforced ONLY through `/a/<token>`
  // (checkShareGrant). Revoking the LAST live link would leave a stored gate that nothing
  // can honor - the exact state the PATCH handler refuses to create. Fail loud and let the
  // owner decide, rather than silently dropping a gate they set. Revoking one of several is
  // fine: the survivors keep enforcing it. (See GATE_REQUIRES_ENFORCING_SURFACE in
  // `artifacts/[id].ts` - these two must stay in sync.)
  // An expiring link reaches that state without passing here: once the last live link lapses,
  // the gate fails closed and PATCH refuses gate/visibility edits until the gate is cleared or
  // the artifact made public.
  const gateNeedsALink = Boolean(artifact.accessGate) && artifact.visibility !== 'public';
  if (live.length && survivors === 0 && gateNeedsALink) throw orphanGateError();

  if (revoking.length) {
    // Stamped rather than pulled, so the token stays claimed in the unique index and its view
    // count survives until a later mint prunes it past MAX_SHARE_TOKEN_ENTRIES.
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
      ? { shareTokens: { $elemMatch: { _id: { $ne: new Types.ObjectId(target!.id) }, ...liveShareTokenMatch() } } }
      : {};
    const result = await PublishedArtifact.updateOne(
      { publicId: artifact.publicId, deletedAt: null, ...survivorPin },
      revokeStages(target ? { $eq: ['$$entry._id', new Types.ObjectId(target.id)] } : { $literal: true }, new Date())
    );
    // Lost that race: the siblings this revoke was counting on are gone, so it would now be
    // dropping the last link. Same refusal as the snapshot check, for the same reason.
    if (pinSurvivor && result?.matchedCount === 0) throw orphanGateError();
    logger.info(
      `[PUBLISH] share-token revoked publicId=${artifact.publicId} count=${revoking.length} remaining=${survivors} by=${user.id}`
    );
  }
  return { revoked: true, remaining: survivors };
}

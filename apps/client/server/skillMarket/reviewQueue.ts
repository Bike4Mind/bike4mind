import { SkillListing, SkillListingVersion } from '@bike4mind/database';
import { ForbiddenError, type ISkillListing } from '@bike4mind/common';
import type { TimeIdKeyset } from '@server/utils/cursorPagination';
import { canReviewListing, type MarketActor } from '@bike4mind/server-utils/skillMarket/market';

/** 403 unless the actor is a super-admin or administers at least one organization. */
export function requireReviewer(actor: MarketActor, adminOrgIds: string[]) {
  if (!actor.isAdmin && adminOrgIds.length === 0) throw new ForbiddenError('Reviewers only');
}

/**
 * The listings a reviewer may see. Org admins are scoped BEFORE any queue limit, so other orgs' (or
 * Public) backlog can't crowd theirs out. `scopedListingIds` is null for a super-admin (no scope);
 * `pendingOnly` narrows it to listings holding a version, the only ones a pending row can survive on.
 */
export async function reviewScope(actor: MarketActor, adminOrgIds: string[], { pendingOnly = false } = {}) {
  const scope = actor.isAdmin ? {} : { visibility: 'organization', organizationId: { $in: adminOrgIds } };
  const scopedListingIds = actor.isAdmin
    ? null
    : (
        await SkillListing.find(pendingOnly ? { ...scope, pendingVersionId: { $ne: null } } : scope)
          .select('_id')
          .lean()
      ).map(l => String(l._id));
  return { scope, scopedListingIds };
}

/**
 * The version queues of the review page, shared by GET /api/skills/market/review-queue and its
 * /api/v1 twin. Rows are unserialized; each route renders its own wire shape. Ordered by
 * (createdAt, _id) ascending. Rows are dropped after the query (a pending row the listing's pointer
 * never reached), so `rows` can be shorter than `limit` while `next` is set: `next` is the last
 * version examined, not the last row returned.
 */
export async function loadVersionQueue(
  actor: MarketActor,
  adminOrgIds: string[],
  { filter, limit, after }: { filter: 'pending' | 'audit'; limit: number; after?: TimeIdKeyset }
) {
  const { scope, scopedListingIds } = await reviewScope(actor, adminOrgIds, { pendingOnly: filter !== 'audit' });
  const versionFilter =
    filter === 'audit'
      ? { auditSample: true, auditedAt: null, reviewStatus: { $in: ['auto_approved', 'approved'] } }
      : { reviewStatus: 'pending', scanStatus: 'passed' };
  const versions = await SkillListingVersion.find({
    ...versionFilter,
    ...(scopedListingIds ? { listingId: { $in: scopedListingIds } } : {}),
    ...(after ? { $or: [{ createdAt: { $gt: after.at } }, { createdAt: after.at, _id: { $gt: after.id } }] } : {}),
  })
    .sort({ createdAt: 1, _id: 1 })
    .limit(limit);
  const listings = await SkillListing.find({ _id: { $in: versions.map(v => v.listingId) }, ...scope });
  const byId = new Map(listings.map(l => [String(l._id), l]));

  // The approved version each held one would replace, for the reviewer's diff.
  const previousIds = listings.flatMap(l => (l.currentApprovedVersionId ? [l.currentApprovedVersionId] : []));
  // Not `snapshot`: its files can be large and only the body is diffed (inclusion and exclusion cannot mix).
  const previous = await SkillListingVersion.find({ _id: { $in: previousIds } }).select(
    'version snapshot.name snapshot.description snapshot.body snapshot.argumentHint snapshot.allowedTools snapshot.claudeCodeAllowedTools snapshot.disableModelInvocation'
  );
  const previousById = new Map(previous.map(p => [String(p._id), p.toJSON()]));

  const rows = versions.flatMap(v => {
    const listing = byId.get(v.listingId);
    if (!listing) return [];
    // Only the listing's pending pointer is decidable; a "pending" row the pointer never reached
    // (a crash between the verdict and pointer writes) would 409 on every approve or reject.
    if (filter !== 'audit' && listing.pendingVersionId !== String(v._id)) return [];
    const plain = listing.toJSON() as unknown as ISkillListing;
    const prev = listing.currentApprovedVersionId ? previousById.get(listing.currentApprovedVersionId) : undefined;
    return [
      {
        version: v,
        listing,
        previous: prev && String(prev.id) !== String(v._id) ? prev : null,
        // Self-approvals are audited by someone else, never by their author.
        canDecide:
          canReviewListing(plain, actor, adminOrgIds) && !(filter === 'audit' && plain.authorUserId === actor.id),
      },
    ];
  });
  const last = versions.at(-1);
  return {
    rows,
    next: versions.length === limit && last ? { at: last.createdAt as Date, id: String(last._id) } : null,
  };
}

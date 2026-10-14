// apps/client/pages/api/skills/market/review-queue.ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { Skill, SkillListing, SkillListingReport, SkillListingVersion } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { ForbiddenError, type ISkillListing } from '@bike4mind/common';
import { canReviewListing, serializeListing, type MarketActor } from '@server/skillMarket/market';

const QUEUE_LIMIT = 100;

/**
 * GET /api/skills/market/review-queue?filter=pending|audit|reports|legacy
 *
 * Super-admins see every listing; org admins see their orgs' Organization listings only. `legacy`
 * (super-admin only) lists the pre-market global-read skills for a read-only audit - they are not
 * auto-revoked.
 */
const handler = baseApi({ auth: 'jwtOnly' }).get<Request<{}, {}, {}, { filter?: string }>>(async (req, res) => {
  const actor: MarketActor = { id: req.user!.id, isAdmin: req.user!.isAdmin };
  const adminOrgIds = await organizationRepository.findIdsAdministeredBy(actor.id);
  if (!actor.isAdmin && adminOrgIds.length === 0) throw new ForbiddenError('Reviewers only');

  const filter = req.query.filter ?? 'pending';
  const scope = actor.isAdmin ? {} : { visibility: 'organization', organizationId: { $in: adminOrgIds } };
  // Scope org admins BEFORE the queue limits, so other orgs' (or Public) backlog can't crowd theirs out.
  const scopedListingIds = actor.isAdmin
    ? null
    : (await SkillListing.find(scope).select('_id').lean()).map(l => String(l._id));

  if (filter === 'legacy') {
    if (!actor.isAdmin) throw new ForbiddenError('Super-admins only');
    const skills = await Skill.find({ isGlobalRead: true, isSystem: { $ne: true }, deletedAt: null })
      .select('name description body userId organizationId isGlobalWrite allowedTools updatedAt')
      .sort({ updatedAt: -1 })
      .limit(200);
    const data = skills.map(s => ({
      id: String(s._id),
      name: s.name,
      description: s.description,
      body: s.body,
      allowedTools: s.allowedTools ?? [],
      userId: s.userId,
      organizationId: s.organizationId,
      isGlobalWrite: Boolean(s.isGlobalWrite),
      updatedAt: s.updatedAt,
    }));
    return res.json({ filter, data });
  }

  if (filter === 'reports') {
    const grouped = await SkillListingReport.aggregate<{ _id: string; count: number; reports: unknown[] }>([
      { $match: { status: 'open', ...(scopedListingIds ? { listingId: { $in: scopedListingIds } } : {}) } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$listingId',
          count: { $sum: 1 },
          reports: { $push: { reason: '$reason', details: '$details', createdAt: '$createdAt' } },
        },
      },
      { $sort: { count: -1 } },
      { $limit: QUEUE_LIMIT },
    ]);
    const listings = await SkillListing.find({ _id: { $in: grouped.map(g => g._id) }, ...scope });
    const byId = new Map(listings.map(l => [String(l._id), l]));
    return res.json({
      filter,
      data: grouped.flatMap(g => {
        const listing = byId.get(g._id);
        return listing
          ? [
              {
                listing: serializeListing(listing, { includeToken: true }),
                count: g.count,
                reports: g.reports.slice(0, 20),
              },
            ]
          : [];
      }),
    });
  }

  const versionFilter =
    filter === 'audit'
      ? { auditSample: true, auditedAt: null, reviewStatus: { $in: ['auto_approved', 'approved'] } }
      : { reviewStatus: 'pending', scanStatus: 'passed' };
  const versions = await SkillListingVersion.find({
    ...versionFilter,
    ...(scopedListingIds ? { listingId: { $in: scopedListingIds } } : {}),
  })
    .sort({ createdAt: 1 })
    .limit(QUEUE_LIMIT * 3);
  const listings = await SkillListing.find({ _id: { $in: versions.map(v => v.listingId) }, ...scope });
  const byId = new Map(listings.map(l => [String(l._id), l]));

  // The approved version each held one would replace, for the reviewer's diff.
  const previousIds = listings.flatMap(l => (l.currentApprovedVersionId ? [l.currentApprovedVersionId] : []));
  const previous = await SkillListingVersion.find({ _id: { $in: previousIds } }).select('version snapshot');
  const previousById = new Map(previous.map(p => [String(p._id), p.toJSON()]));

  const data = versions
    .flatMap(v => {
      const listing = byId.get(v.listingId);
      if (!listing) return [];
      const plain = listing.toJSON() as unknown as ISkillListing;
      const prev = listing.currentApprovedVersionId ? previousById.get(listing.currentApprovedVersionId) : undefined;
      return [
        {
          version: v.toJSON(),
          listing: serializeListing(listing, { includeToken: true }),
          previous: prev && String(prev.id) !== String(v._id) ? prev : null,
          // Self-approvals are audited by someone else, never by their author.
          canDecide:
            canReviewListing(plain, actor, adminOrgIds) && !(filter === 'audit' && plain.authorUserId === actor.id),
        },
      ];
    })
    .slice(0, QUEUE_LIMIT);
  res.json({ filter, data });
});

export default handler;

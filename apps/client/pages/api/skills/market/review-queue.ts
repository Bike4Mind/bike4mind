// apps/client/pages/api/skills/market/review-queue.ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { Skill, SkillListing, SkillListingReport } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { ForbiddenError } from '@bike4mind/common';
import { serializeListing, type MarketActor } from '@server/skillMarket/market';
import { loadVersionQueue, requireReviewer, reviewScope } from '@server/skillMarket/reviewQueue';

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
  requireReviewer(actor, adminOrgIds);

  const filter = req.query.filter ?? 'pending';

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
    const { scope, scopedListingIds } = await reviewScope(actor, adminOrgIds);
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
                listing: serializeListing(listing, { privileged: true }),
                count: g.count,
                reports: g.reports.slice(0, 20),
              },
            ]
          : [];
      }),
    });
  }

  const { rows } = await loadVersionQueue(actor, adminOrgIds, {
    filter: filter === 'audit' ? 'audit' : 'pending',
    limit: QUEUE_LIMIT * 3,
  });
  const data = rows
    .map(({ version, listing, previous, canDecide }) => ({
      version: version.toJSON(),
      listing: serializeListing(listing, { privileged: true }),
      previous,
      canDecide,
    }))
    .slice(0, QUEUE_LIMIT);
  res.json({ filter, data });
});

export default handler;

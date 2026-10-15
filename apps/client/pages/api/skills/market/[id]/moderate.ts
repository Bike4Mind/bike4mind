// apps/client/pages/api/skills/market/[id]/moderate.ts
import { z } from 'zod';
import { baseApi } from '@client/server/middlewares/baseApi';
import { SkillListing, SkillListingReport, SkillListingVersion } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { ConflictError, ForbiddenError, NotFoundError } from '@bike4mind/common';
import { canDelistListing, findListing, notifyUser } from '@server/skillMarket/market';

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('delist'), reason: z.string().trim().min(1).max(1000) }),
  z.object({ action: z.literal('restore') }),
]);

/**
 * POST /api/skills/market/[id]/moderate - one-click takedown (`delist`) or `restore` by a
 * moderator (super-admin, or an admin of the owning org for Organization listings). An org admin
 * can't restore their own listing or reverse a super-admin's delist.
 *
 * Delist hides the listing and blocks new imports; existing copies are kept and show a "delisted
 * by moderators" warning. Restore clears a report-threshold hide (dismissing its reports) or
 * reverses a delist when the listing still has an approved version.
 */
const handler = baseApi({ auth: 'jwtOnly' }).post(async (req, res) => {
  const actor = { id: req.user!.id, isAdmin: req.user!.isAdmin };
  const body = bodySchema.parse(req.body);
  const listing = await findListing(String(req.query.id));
  if (!listing) throw new NotFoundError('Listing not found');
  if (!canDelistListing(listing, actor, await organizationRepository.findIdsAdministeredBy(actor.id))) {
    throw new ForbiddenError("You don't have permission to moderate this listing");
  }
  if (
    body.action === 'restore' &&
    !actor.isAdmin &&
    (listing.authorUserId === actor.id || (listing.status === 'delisted' && listing.delistedBySuperAdmin))
  ) {
    throw new ForbiddenError('Only a platform moderator can restore this listing');
  }
  const listingId = String(listing.id);
  const resolved = { resolvedBy: actor.id, resolvedAt: new Date() };

  if (body.action === 'delist') {
    const res1 = await SkillListing.updateOne(
      { _id: listingId, status: { $nin: ['delisted', 'withdrawn'] } },
      {
        $set: {
          status: 'delisted',
          delistedReason: body.reason,
          delistedBySuperAdmin: Boolean(actor.isAdmin),
          hiddenByReports: false,
          pendingVersionId: null,
          pendingVersion: null,
        },
      }
    );
    if (res1.modifiedCount === 0) throw new ConflictError('This listing is already delisted or withdrawn');
    await SkillListingVersion.updateMany(
      { listingId, reviewStatus: 'pending' },
      { $set: { reviewStatus: 'superseded' } }
    );
    await SkillListingReport.updateMany({ listingId, status: 'open' }, { $set: { status: 'actioned', ...resolved } });
    await notifyUser(
      listing.authorUserId,
      `/${listing.name} was removed from the Skill Market`,
      `A moderator delisted it. Reason: ${body.reason}`
    );
  } else {
    await SkillListingReport.updateMany({ listingId, status: 'open' }, { $set: { status: 'dismissed', ...resolved } });
    await SkillListing.updateOne({ _id: listingId }, { $set: { hiddenByReports: false } });
    await SkillListing.updateOne(
      { _id: listingId, status: 'delisted', currentApprovedVersionId: { $ne: null } },
      { $set: { status: 'approved' }, $unset: { delistedReason: 1, delistedBySuperAdmin: 1 } }
    );
  }
  res.json({ ok: true });
});

export default handler;

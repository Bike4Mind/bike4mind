// apps/client/pages/api/skills/market/[id]/moderate.ts
import { z } from 'zod';
import { baseApi } from '@client/server/middlewares/baseApi';
import { SkillListing, SkillListingReport, SkillListingVersion } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { ConflictError, ForbiddenError, NotFoundError } from '@bike4mind/common';
import {
  canDelistListing,
  canRestoreListing,
  findListing,
  notifyUser,
} from '@bike4mind/server-utils/skillMarket/market';
import { isDuplicateKeyError } from '@bike4mind/server-utils/utils/isDuplicateKeyError';

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
  const adminOrgIds = await organizationRepository.findIdsAdministeredBy(actor.id);
  if (!canDelistListing(listing, actor, adminOrgIds)) {
    throw new ForbiddenError("You don't have permission to moderate this listing");
  }
  if (body.action === 'restore' && !canRestoreListing(listing, actor, adminOrgIds)) {
    throw new ForbiddenError('Only a platform moderator can restore this listing');
  }
  const listingId = String(listing.id);
  const resolved = { resolvedBy: actor.id, resolvedAt: new Date() };

  if (body.action === 'delist') {
    // Read the pre-image: `listing` was fetched before this write, so a concurrent approve could
    // have moved `currentApprovedVersionId` on; the sweep below must skip whatever is live NOW.
    const res1 = await SkillListing.findOneAndUpdate(
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
        $unset: { activeSlot: 1 },
      },
      { new: false }
    );
    if (!res1) throw new ConflictError('This listing is already delisted or withdrawn');
    await SkillListingVersion.updateMany(
      // Defensive: never supersede the version the listing serves, so a restore can still serve it.
      { listingId, reviewStatus: 'pending', _id: { $ne: res1.currentApprovedVersionId } },
      { $set: { reviewStatus: 'superseded' } }
    );
    await SkillListingReport.updateMany({ listingId, status: 'open' }, { $set: { status: 'actioned', ...resolved } });
    await notifyUser(
      listing.authorUserId,
      `/${listing.name} was removed from the Skill Market`,
      `A moderator delisted it. Reason: ${body.reason}`
    );
  } else {
    // Close the reports behind a hide, so the same reporters must report afresh to hide it again.
    await SkillListingReport.updateMany({ listingId, status: 'open' }, { $set: { status: 'dismissed', ...resolved } });
    await SkillListing.updateOne({ _id: listingId }, { $set: { hiddenByReports: false } });
    try {
      await SkillListing.updateOne(
        { _id: listingId, status: 'delisted', currentApprovedVersionId: { $ne: null } },
        { $set: { status: 'approved', activeSlot: true }, $unset: { delistedReason: 1, delistedBySuperAdmin: 1 } }
      );
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictError('The author already has another active listing of this skill');
      }
      throw error;
    }
  }
  res.json({ ok: true });
});

export default handler;

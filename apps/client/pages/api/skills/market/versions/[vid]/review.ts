// apps/client/pages/api/skills/market/versions/[vid]/review.ts
import { z } from 'zod';
import { baseApi } from '@client/server/middlewares/baseApi';
import { SkillListing, SkillListingVersion } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { ConflictError, ForbiddenError, NotFoundError, type ISkillListing } from '@bike4mind/common';
import { canReviewListing } from '@server/skillMarket/market';
import { decideVersion } from '@server/skillMarket/submitVersion';

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    ackHighRisk: z.boolean().optional(),
    ackMismatch: z.boolean().optional(),
    note: z.string().trim().max(2000).optional(),
  }),
  z.object({ action: z.literal('reject'), note: z.string().trim().min(1, 'A note is required to reject').max(2000) }),
  z.object({ action: z.literal('audit') }),
]);

/**
 * POST /api/skills/market/versions/[vid]/review - approve or reject a held version, or mark a
 * sampled auto-approved version as audited. Approve/reject are CAS-guarded (409 when superseded).
 */
const handler = baseApi().post(async (req, res) => {
  const actor = { id: req.user!.id, isAdmin: req.user!.isAdmin };
  const versionId = String(req.query.vid);
  const body = bodySchema.parse(req.body);
  const adminOrgIds = await organizationRepository.findIdsAdministeredBy(actor.id);

  if (body.action !== 'audit') {
    return res.json({ version: await decideVersion(versionId, actor, adminOrgIds, body) });
  }

  const version = await SkillListingVersion.findById(versionId).catch(() => null);
  if (!version) throw new NotFoundError('Version not found');
  const listing = await SkillListing.findById(version.listingId);
  if (!listing) throw new NotFoundError('Listing not found');
  if (!canReviewListing(listing.toJSON() as unknown as ISkillListing, actor, adminOrgIds)) {
    throw new ForbiddenError("You don't have permission to review this listing");
  }
  if (listing.authorUserId === actor.id) throw new ForbiddenError("You can't audit your own listing");
  const marked = await SkillListingVersion.updateOne(
    { _id: versionId, auditSample: true, auditedAt: null },
    { $set: { auditedAt: new Date(), reviewerUserId: actor.id } }
  );
  if (marked.modifiedCount === 0) throw new ConflictError('Already audited');
  res.json({ ok: true });
});

export default handler;

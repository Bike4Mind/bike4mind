// apps/client/pages/api/skills/market/[id]/index.ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { SkillListing, SkillListingVersion } from '@bike4mind/database';
import { ConflictError, ForbiddenError, NotFoundError } from '@bike4mind/common';
import { findListing } from '@server/skillMarket/market';
import { buildListingDetail } from '@server/skillMarket/detail';

const handler = baseApi({ auth: 'jwtOnly' })
  /** GET /api/skills/market/[id]?token= - listing detail; `token` unlocks an unlisted listing. */
  .get<Request<{}, {}, {}, { id: string; token?: string }>>(async (req, res) => {
    const listing = await findListing(String(req.query.id));
    if (!listing) throw new NotFoundError('Listing not found');
    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    res.json(await buildListingDetail(listing, { id: req.user!.id, isAdmin: req.user!.isAdmin }, token));
  })
  /**
   * DELETE /api/skills/market/[id] - the author withdraws the listing. Importers keep their copies
   * and see "no longer available"; a held version is superseded so it can't be approved later.
   */
  .delete<Request<{}, {}, {}, { id: string }>>(async (req, res) => {
    const listing = await findListing(String(req.query.id));
    if (!listing) throw new NotFoundError('Listing not found');
    if (listing.authorUserId !== req.user!.id) throw new ForbiddenError('Only the author can withdraw a listing');

    const before = await SkillListing.findOneAndUpdate(
      { _id: listing.id, status: { $nin: ['withdrawn', 'delisted'] } },
      { $set: { status: 'withdrawn', pendingVersionId: null, pendingVersion: null } },
      { new: false }
    );
    if (!before) throw new ConflictError('This listing is already withdrawn or delisted');
    await SkillListingVersion.updateMany(
      { listingId: String(listing.id), reviewStatus: 'pending' },
      { $set: { reviewStatus: 'superseded' } }
    );
    res.status(204).end();
  });

export default handler;

// apps/client/pages/api/skills/market/[id]/rating.ts
import { z } from 'zod';
import { baseApi } from '@client/server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { SkillListing, SkillListingImport } from '@bike4mind/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/common';
import { canSeeListing, findListing, memberOrgIdsFor } from '@server/skillMarket/market';
import { scanPublicText } from '@server/skillMarket/scanRules';

const bodySchema = z.object({
  stars: z.number().int().min(1).max(5),
  review: z.string().trim().max(1000).optional(),
  token: z.string().max(64).optional(),
});

/**
 * PUT /api/skills/market/[id]/rating - rate a listing you imported (one editable rating per user;
 * the author can't rate their own). The rating lives on the import row, so "importer only" and
 * "one per user" come from that row's unique index. The aggregate moves by the delta from the
 * row's pre-image, so an edit never double-counts.
 */
const handler = baseApi()
  .use(rateLimit({ limit: 30, windowMs: 60 * 60 * 1000, bucket: 'skill-market-rating' }))
  .put(async (req, res) => {
    const userId = req.user!.id;
    const body = bodySchema.parse(req.body);
    const listing = await findListing(String(req.query.id));
    const hasImported = listing
      ? Boolean(await SkillListingImport.exists({ listingId: String(listing.id), userId }))
      : false;
    if (!listing || !canSeeListing(listing, await memberOrgIdsFor(userId), body.token, hasImported)) {
      throw new NotFoundError('Listing not found');
    }
    if (listing.authorUserId === userId) throw new ForbiddenError("You can't rate your own listing");

    if (body.review) {
      const findings = scanPublicText(body.review);
      if (findings.length) throw new BadRequestError(`Review not accepted: ${findings.map(f => f.message).join('; ')}`);
    }

    const before = await SkillListingImport.findOneAndUpdate(
      { listingId: String(listing.id), userId },
      { $set: { stars: body.stars, review: body.review || undefined, ratedAt: new Date() } },
      { new: false }
    );
    if (!before) throw new ForbiddenError('Import this skill before rating it');

    await SkillListing.updateOne(
      { _id: listing.id },
      { $inc: { ratingSum: body.stars - (before.stars ?? 0), ratingCount: before.stars ? 0 : 1 } }
    );
    res.json({ ok: true });
  });

export default handler;

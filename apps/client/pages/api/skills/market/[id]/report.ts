// apps/client/pages/api/skills/market/[id]/report.ts
import { z } from 'zod';
import { baseApi } from '@client/server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import {
  SKILL_LISTING_REPORT_REASONS,
  SkillListing,
  SkillListingImport,
  SkillListingReport,
} from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/common';
import { canSeeListing, findListing, loadMarketSettings, memberOrgIdsFor } from '@server/skillMarket/market';
import { isDuplicateKeyError } from '@bike4mind/server-utils/utils/isDuplicateKeyError';

const DAY_MS = 24 * 60 * 60 * 1000;

const bodySchema = z.object({
  reason: z.enum(SKILL_LISTING_REPORT_REASONS),
  details: z.string().trim().max(2000).optional(),
  token: z.string().max(64).optional(),
});

/**
 * POST /api/skills/market/[id]/report - flag a listing. One open report per (listing, reporter);
 * once open reports from SkillMarketReportAutoHideThreshold distinct established users (accounts past
 * SkillMarketPublicMinAccountAgeDays, or super-admins) pile up, the listing is hidden from the
 * market until an admin restores or delists it (mirrors app-store takedown queues). Rate-limited
 * per user so one account can't flood the queue across many listings.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: 10, windowMs: 60 * 60 * 1000, bucket: 'skill-market-report' }))
  .post(async (req, res) => {
    const userId = req.user!.id;
    const body = bodySchema.parse(req.body);
    const listing = await findListing(String(req.query.id));
    const hasImported = listing
      ? Boolean(await SkillListingImport.exists({ listingId: String(listing.id), userId }))
      : false;
    if (!listing || !canSeeListing(listing, await memberOrgIdsFor(userId), body.token, hasImported)) {
      throw new NotFoundError('Listing not found');
    }
    if (listing.authorUserId === userId) throw new BadRequestError("You can't report your own listing");

    const { reportAutoHideThreshold, publicMinAccountAgeDays } = await loadMarketSettings();
    // Same bar as publishing Public, so a few throwaway accounts can't take a listing down. Importing
    // is no substitute: a fresh account can import any Public listing in one click.
    const ageDays = (Date.now() - new Date(req.user!.createdAt).getTime()) / DAY_MS;
    const countsTowardHide = Boolean(req.user!.isAdmin) || ageDays >= publicMinAccountAgeDays;
    try {
      await SkillListingReport.create({
        listingId: String(listing.id),
        reporterId: userId,
        reason: body.reason,
        details: body.details,
        countsTowardHide,
        status: 'open',
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) return res.json({ ok: true, alreadyReported: true });
      throw error;
    }

    const openReports = await SkillListingReport.countDocuments({
      listingId: String(listing.id),
      status: 'open',
      countsTowardHide: { $ne: false },
    });
    if (openReports >= reportAutoHideThreshold) {
      await SkillListing.updateOne({ _id: listing.id, status: 'approved' }, { $set: { hiddenByReports: true } });
    }
    req.logger.info(`[SKILL_MARKET] report listing=${listing.id} reason=${body.reason}`);
    res.json({ ok: true });
  });

export default handler;

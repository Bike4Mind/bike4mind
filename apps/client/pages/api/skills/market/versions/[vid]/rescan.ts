// apps/client/pages/api/skills/market/versions/[vid]/rescan.ts
import { baseApi } from '@client/server/middlewares/baseApi';
import { SkillListingVersion } from '@bike4mind/database';
import { ForbiddenError, NotFoundError } from '@bike4mind/common';
import { findListing, submitRateLimits } from '@server/skillMarket/market';
import { rescanVersion } from '@server/skillMarket/submitVersion';
import { getOperationsClassifierLlm } from '@server/skillMarket/classifySkill';

/** POST /api/skills/market/versions/[vid]/rescan - the author retries a scan that errored or stalled. */
const handler = baseApi()
  .use(...submitRateLimits())
  .post(async (req, res) => {
    const user = req.user!;
    const version = await SkillListingVersion.findById(String(req.query.vid)).catch(() => null);
    if (!version) throw new NotFoundError('Version not found');
    const listing = await findListing(version.listingId);
    if (!listing || listing.authorUserId !== user.id) throw new ForbiddenError('Only the author can rescan');

    res.json({
      version: await rescanVersion(listing, String(version._id), {
        getClassifier: () => getOperationsClassifierLlm(req.logger, user.id),
      }),
    });
  });

export default handler;

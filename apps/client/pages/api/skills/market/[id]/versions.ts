// apps/client/pages/api/skills/market/[id]/versions.ts
import { z } from 'zod';
import { baseApi } from '@client/server/middlewares/baseApi';
import { SkillListing, skillRepository } from '@bike4mind/database';
import { ConflictError, ForbiddenError, NotFoundError } from '@bike4mind/common';
import { findListing, serializeListing, submitRateLimits, validateListingTags } from '@server/skillMarket/market';
import { submitListingVersion } from '@server/skillMarket/submitVersion';
import { getOperationsClassifierLlm } from '@server/skillMarket/classifySkill';

const bodySchema = z.object({ tags: z.array(z.string()).optional() });

/**
 * POST /api/skills/market/[id]/versions - submit the source skill's current content as a new
 * version. It is scanned and tiered like the first one; until it is approved, everyone keeps
 * seeing and importing the previous approved version.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(...submitRateLimits())
  .post(async (req, res) => {
    const user = req.user!;
    const listing = await findListing(String(req.query.id));
    if (!listing) throw new NotFoundError('Listing not found');
    if (listing.authorUserId !== user.id) throw new ForbiddenError('Only the author can submit a new version');
    if (listing.status === 'withdrawn' || listing.status === 'delisted') {
      throw new ConflictError('This listing no longer accepts new versions');
    }

    const skill = await skillRepository.findById(listing.sourceSkillId);
    if (!skill || skill.userId !== user.id || skill.deletedAt) {
      throw new NotFoundError('The skill this listing was published from no longer exists');
    }

    const { tags } = bodySchema.parse(req.body ?? {});
    if (tags) await SkillListing.updateOne({ _id: listing.id }, { $set: { tags: validateListingTags(tags) } });

    const version = await submitListingVersion(listing, skill, {
      getClassifier: () => getOperationsClassifierLlm(req.logger, user.id),
    });
    const fresh = await SkillListing.findById(listing.id);
    res.status(201).json({ listing: serializeListing(fresh!, { includeToken: true }), version });
  });

export default handler;

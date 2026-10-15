// apps/client/pages/api/skills/market/publish.ts
import { z } from 'zod';
import { baseApi } from '@client/server/middlewares/baseApi';
import { SkillListing, SkillListingVersion, skillRepository } from '@bike4mind/database';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, type ISkillListing } from '@bike4mind/common';
import {
  loadMarketSettings,
  memberOrgIdsFor,
  serializeListing,
  submitRateLimits,
  validateListingTags,
} from '@server/skillMarket/market';
import { submitListingVersion } from '@server/skillMarket/submitVersion';
import { getOperationsClassifierLlm } from '@server/skillMarket/classifySkill';

const bodySchema = z.object({
  skillId: z.string().min(1),
  visibility: z.enum(['public', 'organization', 'unlisted']),
  organizationId: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * POST /api/skills/market/publish - create a listing from a skill the caller owns and submit its
 * first version for the safety scan. Responds with the listing and the scanned version, so the
 * dialog can show the verdict inline.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(...submitRateLimits())
  .post(async (req, res) => {
    const user = req.user!;
    const body = bodySchema.parse(req.body);
    const tags = validateListingTags(body.tags);

    const skill = await skillRepository.findById(body.skillId);
    // Only a user-scoped skill the caller owns can be published - never a shared, org or system one.
    if (!skill || skill.userId !== user.id) throw new NotFoundError('Skill not found');
    if (skill.importedFrom) {
      throw new BadRequestError("You can't republish a skill imported from the market");
    }

    const settings = await loadMarketSettings();

    if (body.visibility === 'organization') {
      if (!body.organizationId) throw new BadRequestError('Choose an organization');
      if (!(await memberOrgIdsFor(user.id)).includes(body.organizationId)) {
        throw new ForbiddenError('You can only publish to organizations you belong to');
      }
    }
    if (body.visibility === 'public' && !user.isAdmin) {
      const ageDays = (Date.now() - new Date(user.createdAt).getTime()) / DAY_MS;
      if (!(ageDays >= settings.publicMinAccountAgeDays)) {
        throw new ForbiddenError(
          `New accounts can publish Public listings after ${settings.publicMinAccountAgeDays} days. Organization and unlisted listings are available now.`
        );
      }
    }

    const live = { authorUserId: user.id, status: { $nin: ['withdrawn', 'delisted'] }, deletedAt: null };
    if (await SkillListing.exists({ ...live, sourceSkillId: skill.id })) {
      throw new ConflictError('This skill already has a listing. Submit a new version from My listings instead.');
    }
    if ((await SkillListing.countDocuments(live)) >= settings.maxListingsPerUser) {
      throw new BadRequestError(`You can have at most ${settings.maxListingsPerUser} active listings`);
    }

    const created = await SkillListing.create({
      sourceSkillId: skill.id,
      authorUserId: user.id,
      authorName: (user.name || user.username || 'A Bike4Mind user').slice(0, 200),
      visibility: body.visibility,
      ...(body.visibility === 'organization' ? { organizationId: body.organizationId } : {}),
      tags,
      name: skill.name,
      description: skill.description,
    });
    const listing = created.toJSON() as unknown as ISkillListing;
    // The exists() check above races a concurrent publish of the same skill; the younger listing yields.
    const first = await SkillListing.findOne({ ...live, sourceSkillId: skill.id })
      .sort({ _id: 1 })
      .select('_id');
    if (first && String(first._id) !== listing.id) {
      await SkillListing.deleteOne({ _id: listing.id });
      throw new ConflictError('This skill already has a listing. Submit a new version from My listings instead.');
    }

    let version;
    try {
      version = await submitListingVersion(listing, skill, {
        settings,
        getClassifier: () => getOperationsClassifierLlm(req.logger, user.id),
      });
    } catch (error) {
      // Don't leave an empty listing counting toward maxListingsPerUser.
      if (!(await SkillListingVersion.exists({ listingId: listing.id })))
        await SkillListing.deleteOne({ _id: listing.id });
      throw error;
    }

    const fresh = await SkillListing.findById(listing.id);
    res.status(201).json({ listing: serializeListing(fresh!, { privileged: true }), version });
  });

export default handler;

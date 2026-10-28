import { SkillListing, SkillListingVersion, skillRepository } from '@bike4mind/database';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type ISkillListing,
  type ISkillListingVersion,
  type SkillListingVisibility,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { isDuplicateKeyError } from '@bike4mind/server-utils/utils/isDuplicateKeyError';
import type { TimeIdKeyset } from '@server/utils/cursorPagination';
import {
  findListing,
  loadMarketSettings,
  meetsPublicAccountAge,
  memberOrgIdsFor,
  validateListingTags,
  withdrawListing,
  type MarketActor,
} from './market';
import { rescanVersion, submitListingVersion } from './submitVersion';
import { getOperationsClassifierLlm } from './classifySkill';

/**
 * The author's side of the Skill Market, shared by the SPA routes under pages/api/skills/market/*
 * and their /api/v1 twins under pages/api/v1/skills/market/*. Each returns domain objects; the
 * routes render them (serializeListing for the SPA, publicView.ts for v1).
 */

export type MarketAuthor = MarketActor & { name?: string; username?: string; createdAt?: Date | string };

const ALREADY_LISTED = 'This skill already has a listing. Submit a new version from My listings instead.';

/**
 * Create a listing from a skill the caller owns and submit its first version for the safety scan.
 * Returns the listing as stored after the scan, and the scanned version.
 */
export async function publishListing(
  user: MarketAuthor,
  input: { skillId: string; visibility: SkillListingVisibility; organizationId?: string; tags?: string[] },
  logger: Logger
) {
  const tags = validateListingTags(input.tags);

  const skill = await skillRepository.findById(input.skillId);
  // Only a user-scoped skill the caller owns can be published - never a shared, org or system one.
  if (!skill || skill.userId !== user.id) throw new NotFoundError('Skill not found');
  if (skill.importedFrom) {
    throw new BadRequestError("You can't republish a skill imported from the market");
  }

  const settings = await loadMarketSettings();

  if (input.visibility === 'organization') {
    if (!input.organizationId) throw new BadRequestError('Choose an organization');
    if (!(await memberOrgIdsFor(user.id)).includes(input.organizationId)) {
      throw new ForbiddenError('You can only publish to organizations you belong to');
    }
  }
  if (input.visibility === 'public' && !meetsPublicAccountAge(user, settings)) {
    throw new ForbiddenError(
      `New accounts can publish Public listings after ${settings.publicMinAccountAgeDays} days. Organization and unlisted listings are available now.`
    );
  }

  // A moderator takedown is not the author's to undo by publishing the same skill again.
  const takenDown = await SkillListing.exists({
    authorUserId: user.id,
    sourceSkillId: skill.id,
    deletedAt: null,
    $or: [{ status: 'delisted' }, { status: 'withdrawn', hiddenByReports: true }],
  });
  if (takenDown) {
    throw new ForbiddenError(
      'This skill was removed from the Skill Market by moderators. Contact a moderator to have it restored.'
    );
  }

  const live = { authorUserId: user.id, status: { $nin: ['withdrawn', 'delisted'] }, deletedAt: null };
  if (await SkillListing.exists({ ...live, sourceSkillId: skill.id })) {
    throw new ConflictError(ALREADY_LISTED);
  }
  // Best-effort: two concurrent publishes of different skills can both pass this count.
  if ((await SkillListing.countDocuments(live)) >= settings.maxListingsPerUser) {
    throw new BadRequestError(`You can have at most ${settings.maxListingsPerUser} active listings`);
  }

  let created;
  try {
    created = await SkillListing.create({
      sourceSkillId: skill.id,
      authorUserId: user.id,
      authorName: (user.name || user.username || 'A Bike4Mind user').slice(0, 200),
      visibility: input.visibility,
      ...(input.visibility === 'organization' ? { organizationId: input.organizationId } : {}),
      tags,
      name: skill.name,
      description: skill.description,
    });
  } catch (error) {
    // The partial unique index on (authorUserId, sourceSkillId) settles a concurrent publish.
    if (isDuplicateKeyError(error)) throw new ConflictError(ALREADY_LISTED);
    throw error;
  }
  const listing = created.toJSON() as unknown as ISkillListing;

  let version;
  try {
    version = await submitListingVersion(listing, skill, {
      settings,
      getClassifier: () => getOperationsClassifierLlm(logger, user.id),
    });
  } catch (error) {
    // Don't leave an empty listing holding a slot. Soft delete by hand: the plugin's deleteOne
    // would leave `activeSlot` set, so the unique index would still block a retry.
    try {
      if (!(await SkillListingVersion.exists({ listingId: listing.id }))) {
        await SkillListing.updateOne(
          { _id: listing.id },
          { $set: { deletedAt: new Date() }, $unset: { activeSlot: 1 } }
        );
      }
    } catch (cleanupError) {
      // Surface the submit failure, not the cleanup's.
      logger.error(`[SKILL_MARKET] publish cleanup failed listing=${listing.id}`, cleanupError);
    }
    throw error;
  }

  const fresh = await SkillListing.findById(listing.id);
  return { listing: fresh!, version };
}

/**
 * Submit the source skill's current content as a new version. It is scanned and tiered like the
 * first one; until it is approved, everyone keeps seeing and importing the previous approved version.
 */
export async function submitNewVersion(
  user: MarketActor,
  listingId: string,
  tags: string[] | undefined,
  logger: Logger
) {
  const listing = await findListing(listingId);
  if (!listing) throw new NotFoundError('Listing not found');
  if (listing.authorUserId !== user.id) throw new ForbiddenError('Only the author can submit a new version');
  if (listing.status === 'withdrawn' || listing.status === 'delisted') {
    throw new ConflictError('This listing no longer accepts new versions');
  }
  // Membership is checked at publish time but can lapse afterwards. An Organization listing must
  // not keep auto-publishing into an org its author has been removed from.
  if (
    listing.visibility === 'organization' &&
    !(await memberOrgIdsFor(user.id)).includes(listing.organizationId ?? '')
  ) {
    throw new ForbiddenError('You can only publish to organizations you belong to');
  }

  const skill = await skillRepository.findById(listing.sourceSkillId);
  if (!skill || skill.userId !== user.id || skill.deletedAt) {
    throw new NotFoundError('The skill this listing was published from no longer exists');
  }

  const validTags = tags ? validateListingTags(tags) : undefined;

  const version = await submitListingVersion(listing, skill, {
    getClassifier: () => getOperationsClassifierLlm(logger, user.id),
  });
  // Only after the submit is accepted, so a refused resubmit leaves the listing untouched.
  if (validTags) await SkillListing.updateOne({ _id: listing.id }, { $set: { tags: validTags } });
  const fresh = await SkillListing.findById(listing.id);
  return { listing: fresh!, version };
}

/** The author retries a scan that errored or stalled. */
export async function rescanOwnVersion(user: MarketActor, versionId: string, logger: Logger) {
  const version = await SkillListingVersion.findById(versionId).catch(() => null);
  if (!version) throw new NotFoundError('Version not found');
  const listing = await findListing(version.listingId);
  if (!listing || listing.authorUserId !== user.id) throw new ForbiddenError('Only the author can rescan');
  // A rescan can turn an unpublished Organization version live, so the author's membership must
  // still hold at this point too.
  if (
    listing.visibility === 'organization' &&
    !(await memberOrgIdsFor(user.id)).includes(listing.organizationId ?? '')
  ) {
    throw new ForbiddenError('You can only publish to organizations you belong to');
  }

  return rescanVersion(listing, String(version._id), {
    getClassifier: () => getOperationsClassifierLlm(logger, user.id),
  });
}

/** The author withdraws the listing (see `withdrawListing`). */
export async function withdrawOwnListing(userId: string, listingId: string): Promise<void> {
  const listing = await findListing(listingId);
  if (!listing) throw new NotFoundError('Listing not found');
  if (listing.authorUserId !== userId) throw new ForbiddenError('Only the author can withdraw a listing');

  if (!(await withdrawListing(listing.id))) throw new ConflictError('This listing is already withdrawn or delisted');
}

/**
 * The caller's listings, newest first, each with its 5 newest versions (findings and review notes
 * included, snapshot bodies not). `next` is the keyset to resume after, null on the last page.
 */
export async function listMyListings(
  userId: string,
  { limit, after, sourceSkillId }: { limit: number; after?: TimeIdKeyset; sourceSkillId?: string }
) {
  const filter: Record<string, unknown> = { authorUserId: userId, deletedAt: null };
  if (sourceSkillId) filter.sourceSkillId = sourceSkillId;
  if (after) {
    filter.$or = [{ createdAt: { $lt: after.at } }, { createdAt: after.at, _id: { $lt: after.id } }];
  }
  const rows = await SkillListing.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1);
  const listings = rows.slice(0, limit);
  // One bounded query per listing: a shared sort+limit would let a listing with many versions
  // crowd the others out of the page.
  const perListing = await Promise.all(
    listings.map(l =>
      SkillListingVersion.find({ listingId: String(l._id) })
        .sort({ version: -1 })
        .select('-snapshot.body -snapshot.files')
        .limit(5)
    )
  );
  const byListing = new Map(
    listings.map((l, i) => [String(l._id), perListing[i].map(v => v.toJSON() as unknown as ISkillListingVersion)])
  );

  const last = listings.at(-1);
  return {
    listings: listings.map(listing => ({ listing, versions: byListing.get(String(listing._id)) ?? [] })),
    next: rows.length > limit && last ? { at: last.createdAt as Date, id: String(last._id) } : null,
  };
}

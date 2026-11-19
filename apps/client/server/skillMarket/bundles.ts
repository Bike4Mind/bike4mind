import mongoose from 'mongoose';
import { z } from 'zod';
import { SKILL_BUNDLE_MAX_LISTINGS, SkillBundle, SkillListing, spaceRepository } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  claudeNameSlug,
  type ISkillBundle,
  type ISkillListing,
} from '@bike4mind/common';
import { isDuplicateKeyError } from '@bike4mind/server-utils/utils/isDuplicateKeyError';
import { isFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import {
  adminAudienceIdsFor,
  audienceIdsFor,
  marketVisibilityFilter,
  type MarketActor,
} from '@bike4mind/server-utils/skillMarket/market';

/**
 * Org and Space skill bundles (SkillBundleModel), managed by org admins (Space owners and admins for a
 * Space) and super-admins, and served by the Claude Code feed (claudeMarketplace.ts). A bundle holds
 * only its owner's approved listings, each reviewed on its own, so curation needs no review.
 */

/** Exactly one of the two, like the bundle row itself. */
export type BundleOwner =
  { organizationId: string; spaceId?: undefined } | { spaceId: string; organizationId?: undefined };

const ownerFilter = (owner: BundleOwner) =>
  owner.spaceId ? { spaceId: owner.spaceId } : { organizationId: owner.organizationId };

const ownerOf = (bundle: ISkillBundle): BundleOwner =>
  bundle.spaceId ? { spaceId: bundle.spaceId } : { organizationId: bundle.organizationId! };

const ownerNoun = (owner: BundleOwner) => (owner.spaceId ? 'space' : 'organization');

/** Spaces answer only while `EnableSpaces` is on, for super-admins too. */
async function assertOwnerEnabled(owner: BundleOwner): Promise<void> {
  if (owner.spaceId && !(await isFeatureEnabled('EnableSpaces'))) throw new NotFoundError('Space not found');
}

/** Reads `organizationId` or `spaceId` off a request, exactly one. */
export function bundleOwnerFrom(input: { organizationId?: unknown; spaceId?: unknown }): BundleOwner {
  const { organizationId, spaceId } = input;
  const org = typeof organizationId === 'string' && organizationId ? organizationId : undefined;
  const space = typeof spaceId === 'string' && spaceId ? spaceId : undefined;
  if ((org === undefined) === (space === undefined)) throw new BadRequestError('Send exactly one of orgId or spaceId');
  return space ? { spaceId: space } : { organizationId: org! };
}

/** A listing a bundle may hold, as the bundle editor's picker shows it. */
export type BundleCandidate = { id: string; name: string; pluginName: string };

const fieldsSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(500),
  listingIds: z.array(z.string()).min(1).max(SKILL_BUNDLE_MAX_LISTINGS),
});

const parse = <T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> => {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestError(result.error.issues[0]?.message ?? 'Invalid bundle');
  return result.data;
};

const toBundle = (doc: { toJSON: () => unknown }) => doc.toJSON() as ISkillBundle;

const ownerListingFilter = (owner: BundleOwner) => ({
  ...marketVisibilityFilter(
    owner.spaceId ? { orgIds: [], spaceIds: [owner.spaceId] } : { orgIds: [owner.organizationId ?? ''], spaceIds: [] }
  ),
  visibility: owner.spaceId ? 'space' : 'organization',
  ...ownerFilter(owner),
  // Unnamed listings are not in the feed yet, so a bundle could not place them either.
  claudePluginName: { $type: 'string' },
});

async function canManage(actor: MarketActor, owner: BundleOwner): Promise<boolean> {
  if (actor.isAdmin) return true;
  const admin = await adminAudienceIdsFor(actor.id);
  return owner.spaceId ? admin.spaceIds.includes(owner.spaceId) : admin.orgIds.includes(owner.organizationId ?? '');
}

async function assertCanManage(actor: MarketActor, owner: BundleOwner): Promise<void> {
  await assertOwnerEnabled(owner);
  if (!(await canManage(actor, owner))) {
    throw new ForbiddenError(`Only ${ownerNoun(owner)} admins can manage bundles`);
  }
}

/** Deduped ids, all of them approved listings of the owner. */
async function validListingIds(owner: BundleOwner, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  const found = unique.every(id => mongoose.isObjectIdOrHexString(id))
    ? await SkillListing.countDocuments({ ...ownerListingFilter(owner), _id: { $in: unique } })
    : -1;
  if (found !== unique.length) {
    throw new BadRequestError(`A bundle can only hold this ${ownerNoun(owner)}'s approved listings`);
  }
  return unique;
}

/** The owner's bundles and the listings they may hold. Members only (404 otherwise, like the feed). */
export async function listBundles(
  actor: MarketActor,
  owner: BundleOwner
): Promise<{ bundles: ISkillBundle[]; listings: BundleCandidate[]; canEdit: boolean }> {
  await assertOwnerEnabled(owner);
  const canEdit = await canManage(actor, owner);
  if (!canEdit) {
    const audience = await audienceIdsFor(actor.id);
    const member = owner.spaceId
      ? audience.spaceIds.includes(owner.spaceId)
      : audience.orgIds.includes(owner.organizationId ?? '');
    if (!member) throw new NotFoundError(owner.spaceId ? 'Space not found' : 'Organization not found');
  }
  const [bundles, listings] = await Promise.all([
    SkillBundle.find(ownerFilter(owner)).sort({ _id: 1 }),
    SkillListing.find(ownerListingFilter(owner)).sort({ name: 1 }),
  ]);
  return {
    bundles: bundles.map(toBundle),
    listings: listings.map(d => {
      const l = d.toJSON() as unknown as ISkillListing;
      return { id: String(l.id), name: l.name, pluginName: l.claudePluginName! };
    }),
    canEdit,
  };
}

export async function createBundle(actor: MarketActor, body: unknown): Promise<ISkillBundle> {
  const { organizationId, spaceId, ...rest } = parse(
    fieldsSchema.extend({ organizationId: z.string().min(1).optional(), spaceId: z.string().min(1).optional() }),
    body
  );
  const owner = bundleOwnerFrom({ organizationId, spaceId });
  await assertCanManage(actor, owner);
  // A super-admin passes assertCanManage for any id, so confirm the owner exists.
  if (actor.isAdmin) {
    const ownerId = owner.spaceId ?? owner.organizationId;
    const exists =
      mongoose.isObjectIdOrHexString(ownerId) &&
      (owner.spaceId ? await spaceRepository.findLiveById(ownerId) : await organizationRepository.findById(ownerId));
    if (!exists) throw new NotFoundError(owner.spaceId ? 'Space not found' : 'Organization not found');
  }
  const pluginName = claudeNameSlug(rest.name);
  if (!pluginName) throw new BadRequestError('A bundle name needs letters or digits');
  // Bundles and listings share the feed's plugin names; assignClaudePluginName guards the other direction.
  if (await SkillListing.exists({ ...ownerFilter(owner), claudePluginName: pluginName })) {
    throw new ConflictError(`A skill in this ${ownerNoun(owner)}'s marketplace is already named "${pluginName}"`);
  }
  const listingIds = await validListingIds(owner, rest.listingIds);
  try {
    return toBundle(
      await SkillBundle.create({ ...rest, listingIds, ...ownerFilter(owner), pluginName, createdByUserId: actor.id })
    );
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new ConflictError(`A bundle named "${pluginName}" already exists`);
    throw err;
  }
}

/** Edits name, description and members. The plugin name stays fixed: installs are keyed on it. */
export async function updateBundle(actor: MarketActor, id: string, body: unknown): Promise<ISkillBundle> {
  const bundle = await findBundle(id);
  await assertCanManage(actor, ownerOf(bundle));
  const patch = parse(fieldsSchema.partial(), body);
  if (patch.listingIds) {
    const existing = new Set(bundle.listingIds.map(String));
    const unique = [...new Set(patch.listingIds)];
    await validListingIds(
      ownerOf(bundle),
      unique.filter(id => !existing.has(id))
    );
    patch.listingIds = unique;
  }
  const updated = await SkillBundle.findByIdAndUpdate(id, { $set: patch }, { new: true });
  if (!updated) throw new NotFoundError('Bundle not found');
  return toBundle(updated);
}

export async function deleteBundle(actor: MarketActor, id: string): Promise<void> {
  const bundle = await findBundle(id);
  await assertCanManage(actor, ownerOf(bundle));
  await SkillBundle.deleteOne({ _id: id });
}

async function findBundle(id: string): Promise<ISkillBundle> {
  const doc = mongoose.isObjectIdOrHexString(id) ? await SkillBundle.findById(id) : null;
  if (!doc) throw new NotFoundError('Bundle not found');
  return toBundle(doc);
}

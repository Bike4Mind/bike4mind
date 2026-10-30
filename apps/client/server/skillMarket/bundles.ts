import mongoose from 'mongoose';
import { z } from 'zod';
import { SKILL_BUNDLE_MAX_LISTINGS, SkillBundle, SkillListing } from '@bike4mind/database';
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
import { marketVisibilityFilter, memberOrgIdsFor, type MarketActor } from './market';

/**
 * Org skill bundles (SkillBundleModel), managed by org admins and super-admins from the Team
 * marketplace dialog and served by the Claude Code feed (claudeMarketplace.ts). A bundle holds only
 * the org's approved Organization listings, each reviewed on its own, so curation needs no review.
 */

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

const orgListingFilter = (organizationId: string) => ({
  ...marketVisibilityFilter([organizationId]),
  visibility: 'organization',
  organizationId,
  // Unnamed listings are not in the feed yet, so a bundle could not place them either.
  claudePluginName: { $type: 'string' },
});

async function canManage(actor: MarketActor, organizationId: string): Promise<boolean> {
  return (
    Boolean(actor.isAdmin) || (await organizationRepository.findIdsAdministeredBy(actor.id)).includes(organizationId)
  );
}

async function assertCanManage(actor: MarketActor, organizationId: string): Promise<void> {
  if (!(await canManage(actor, organizationId)))
    throw new ForbiddenError('Only organization admins can manage bundles');
}

/** Deduped ids, all of them approved Organization listings of the org. */
async function validListingIds(organizationId: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  const found = unique.every(id => mongoose.isObjectIdOrHexString(id))
    ? await SkillListing.countDocuments({ ...orgListingFilter(organizationId), _id: { $in: unique } })
    : -1;
  if (found !== unique.length) {
    throw new BadRequestError("A bundle can only hold this organization's approved Organization listings");
  }
  return unique;
}

/** The org's bundles and the listings they may hold. Members only (404 otherwise, like the feed). */
export async function listBundles(
  actor: MarketActor,
  organizationId: string
): Promise<{ bundles: ISkillBundle[]; listings: BundleCandidate[]; canEdit: boolean }> {
  const canEdit = await canManage(actor, organizationId);
  if (!canEdit && !(await memberOrgIdsFor(actor.id)).includes(organizationId)) {
    throw new NotFoundError('Organization not found');
  }
  const [bundles, listings] = await Promise.all([
    SkillBundle.find({ organizationId }).sort({ _id: 1 }),
    SkillListing.find(orgListingFilter(organizationId)).sort({ name: 1 }),
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
  const { organizationId, ...rest } = parse(fieldsSchema.extend({ organizationId: z.string().min(1) }), body);
  await assertCanManage(actor, organizationId);
  // A super-admin passes assertCanManage for any id, so confirm the org exists.
  if (
    actor.isAdmin &&
    !(mongoose.isObjectIdOrHexString(organizationId) && (await organizationRepository.findById(organizationId)))
  ) {
    throw new NotFoundError('Organization not found');
  }
  const pluginName = claudeNameSlug(rest.name);
  if (!pluginName) throw new BadRequestError('A bundle name needs letters or digits');
  // Bundles and listings share the feed's plugin names; assignClaudePluginName guards the other direction.
  if (await SkillListing.exists({ organizationId, claudePluginName: pluginName })) {
    throw new ConflictError(`A skill in this organization's marketplace is already named "${pluginName}"`);
  }
  const listingIds = await validListingIds(organizationId, rest.listingIds);
  try {
    return toBundle(
      await SkillBundle.create({ ...rest, listingIds, organizationId, pluginName, createdByUserId: actor.id })
    );
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new ConflictError(`A bundle named "${pluginName}" already exists`);
    throw err;
  }
}

/** Edits name, description and members. The plugin name stays fixed: installs are keyed on it. */
export async function updateBundle(actor: MarketActor, id: string, body: unknown): Promise<ISkillBundle> {
  const bundle = await findBundle(id);
  await assertCanManage(actor, bundle.organizationId);
  const patch = parse(fieldsSchema.partial(), body);
  if (patch.listingIds) {
    const existing = new Set(bundle.listingIds.map(String));
    const unique = [...new Set(patch.listingIds)];
    await validListingIds(
      bundle.organizationId,
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
  await assertCanManage(actor, bundle.organizationId);
  await SkillBundle.deleteOne({ _id: id });
}

async function findBundle(id: string): Promise<ISkillBundle> {
  const doc = mongoose.isObjectIdOrHexString(id) ? await SkillBundle.findById(id) : null;
  if (!doc) throw new NotFoundError('Bundle not found');
  return toBundle(doc);
}

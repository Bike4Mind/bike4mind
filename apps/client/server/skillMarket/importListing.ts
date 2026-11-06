import { SkillListing, SkillListingImport, SkillListingVersion, skillRepository } from '@bike4mind/database';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  type ISkillDocument,
  type ISkillImportedFrom,
  type ISkillListingVersion,
} from '@bike4mind/common';
import { validateSkillName } from '@server/utils/skillValidation';
import { isDuplicateKeyError } from '@bike4mind/server-utils/utils/isDuplicateKeyError';
import { canSeeListing, findListing, memberOrgIdsFor, skillContentHash, type MarketActor } from '@bike4mind/server-utils/skillMarket/market';

export type ImportListingInput = {
  token?: string;
  /** New name for the copy, when the listing's name collides with one of the caller's skills. */
  name?: string;
  /** Update this existing imported copy in place instead of creating a new one. */
  targetSkillId?: string;
  /** Confirms overwriting a copy the importer has edited since importing. */
  overwrite?: boolean;
  /** The version the caller reviewed (e.g. in the update diff); 409 if a newer one was approved since. */
  expectedVersionId?: string;
};

/** First free `<name>-N` for the caller, offered back on a name collision. */
async function suggestName(userId: string, name: string): Promise<string | undefined> {
  for (let n = 2; n <= 20; n++) {
    const candidate = `${name.slice(0, 60)}-${n}`;
    if (!(await skillRepository.findByNameForUser(userId, candidate))) return candidate;
  }
  return undefined;
}

/**
 * Copy the listing's current APPROVED snapshot into a user-scoped skill (or refresh an earlier
 * copy). Pending or rejected content can never reach an importer: the snapshot is read through
 * `currentApprovedVersionId` only. Shared by pages/api/skills/market/[id]/import.ts and its v1 twin;
 * its 409s carry `code` (version_changed, local_changes, name_taken), which v1 renames to `errorCode`.
 */
export async function importListing(user: MarketActor, listingId: string, body: ImportListingInput) {
  const userId = user.id;
  const listing = await findListing(listingId);
  const hasImported = listing
    ? Boolean(await SkillListingImport.exists({ listingId: String(listing.id), userId }))
    : false;
  if (!listing || !canSeeListing(listing, await memberOrgIdsFor(userId), body.token, hasImported)) {
    throw new NotFoundError('Listing not found');
  }
  if (listing.authorUserId === userId) throw new BadRequestError('This is your own listing');

  const versionDoc = listing.currentApprovedVersionId
    ? await SkillListingVersion.findById(listing.currentApprovedVersionId)
    : null;
  const version = versionDoc?.toJSON() as unknown as ISkillListingVersion | undefined;
  if (!version || !['approved', 'auto_approved'].includes(version.reviewStatus)) {
    throw new NotFoundError('Listing not found');
  }
  if (body.expectedVersionId && body.expectedVersionId !== String(version.id)) {
    throw new ConflictError('A newer version was approved since you reviewed this one', {
      code: 'version_changed',
    });
  }

  const snap = version.snapshot;
  const importedFrom: ISkillImportedFrom = {
    listingId: String(listing.id),
    versionId: String(version.id),
    version: version.version,
    contentHash: version.contentHash,
  };
  // Explicit '' / [] (not undefined) so an update clears fields the new version dropped.
  const content = {
    description: snap.description,
    body: snap.body,
    argumentHint: snap.argumentHint ?? '',
    allowedTools: snap.allowedTools ?? [],
    claudeCodeAllowedTools: snap.claudeCodeAllowedTools ?? [],
    disableModelInvocation: Boolean(snap.disableModelInvocation),
    files: snap.files ?? [],
    importedFrom,
  };

  let skill;
  if (body.targetSkillId) {
    const target = await skillRepository.findById(body.targetSkillId);
    if (!target || target.userId !== userId || target.importedFrom?.listingId !== String(listing.id)) {
      throw new NotFoundError('Imported copy not found');
    }
    // A global copy reaches everyone; legacy org/unlisted versions may have auto-approved at
    // the `review` tier. Content changes to a global skill go
    // through `scanGlobalSkillUpdate` on PUT instead; see `globalSkillScanFor` in skillAccess.ts.
    if ((target.isGlobalRead || target.isGlobalWrite) && !user.isAdmin) {
      throw new BadRequestError(
        'This copy is shared with everyone, so it cannot be updated from the market. Edit it directly instead.'
      );
    }
    if (skillContentHash(target) !== target.importedFrom.contentHash && !body.overwrite) {
      throw new ConflictError('You edited this copy since importing it; updating will overwrite your changes', {
        code: 'local_changes',
      });
    }
    // Both writes must notice a concurrent change, or unscanned content can land on a global skill:
    // into a global copy (super-admin only) the write is guarded on the read `__v`, so it and a
    // racing scanned PUT can't combine; into a non-global copy it 409s if the copy went global.
    const isGlobal = Boolean(target.isGlobalRead || target.isGlobalWrite);
    skill = isGlobal
      ? await skillRepository.updateGuarded(
          { id: target.id, __v: (target as { __v?: number }).__v, ...content } as Partial<ISkillDocument>,
          { new: true }
        )
      : await skillRepository.updateIfNonGlobal({ id: target.id, ...content }, { new: true });
    if (!skill) throw new NotFoundError('Imported copy not found');
  } else {
    const name = body.name !== undefined ? validateSkillName(body.name) : snap.name;
    try {
      skill = await skillRepository.create({
        name,
        ...content,
        userId,
        isGlobalRead: false,
        isGlobalWrite: false,
        users: [],
        groups: [],
      } as unknown as Omit<ISkillDocument, 'id' | 'createdAt' | 'updatedAt'>);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictError(`You already have a skill named "${name}"`, {
          code: 'name_taken',
          suggestedName: await suggestName(userId, name),
        });
      }
      throw error;
    }
  }

  // One row per (listing, importer): only the first import counts toward importCount.
  try {
    const before = await SkillListingImport.findOneAndUpdate(
      { listingId: String(listing.id), userId },
      { $set: { skillId: String(skill!.id), version: version.version }, $setOnInsert: { importedAt: new Date() } },
      { upsert: true, new: false }
    );
    if (!before) await SkillListing.updateOne({ _id: listing.id }, { $inc: { importCount: 1 } });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error; // a concurrent first import already counted it
  }

  return { skill: { id: String(skill!.id), name: skill!.name }, created: !body.targetSkillId };
}

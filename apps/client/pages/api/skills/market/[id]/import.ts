// apps/client/pages/api/skills/market/[id]/import.ts
import { z } from 'zod';
import { baseApi } from '@client/server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { SkillListing, SkillListingImport, SkillListingVersion, skillRepository } from '@bike4mind/database';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  type ISkillDocument,
  type ISkillImportedFrom,
  type ISkillListingVersion,
} from '@bike4mind/common';
import { canSeeListing, findListing, memberOrgIdsFor, skillContentHash } from '@server/skillMarket/market';
import { validateSkillName } from '@server/utils/skillValidation';
import { isDuplicateKeyError } from '@server/utils/isDuplicateKeyError';

const bodySchema = z.object({
  token: z.string().max(64).optional(),
  /** New name for the copy, when the listing's name collides with one of the caller's skills. */
  name: z.string().optional(),
  /** Update this existing imported copy in place instead of creating a new one. */
  targetSkillId: z.string().optional(),
  /** Confirms overwriting a copy the importer has edited since importing. */
  overwrite: z.boolean().optional(),
});

/** First free `<name>-N` for the caller, offered back on a name collision. */
async function suggestName(userId: string, name: string): Promise<string | undefined> {
  for (let n = 2; n <= 20; n++) {
    const candidate = `${name.slice(0, 60)}-${n}`;
    if (!(await skillRepository.findByNameForUser(userId, candidate))) return candidate;
  }
  return undefined;
}

/**
 * POST /api/skills/market/[id]/import - copy the listing's current APPROVED snapshot into a
 * user-scoped skill (or refresh an earlier copy). Pending or rejected content can never reach an
 * importer: the snapshot is read through `currentApprovedVersionId` only.
 */
const handler = baseApi()
  .use(rateLimit({ limit: 60, windowMs: 60 * 60 * 1000, bucket: 'skill-market-import' }))
  .post(async (req, res) => {
    const userId = req.user!.id;
    const body = bodySchema.parse(req.body ?? {});
    const listing = await findListing(String(req.query.id));
    if (!listing || !canSeeListing(listing, await memberOrgIdsFor(userId), body.token)) {
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
      disableModelInvocation: Boolean(snap.disableModelInvocation),
      importedFrom,
    };

    let skill;
    if (body.targetSkillId) {
      const target = await skillRepository.findById(body.targetSkillId);
      if (!target || target.userId !== userId || target.importedFrom?.listingId !== String(listing.id)) {
        throw new NotFoundError('Imported copy not found');
      }
      if (skillContentHash(target) !== target.importedFrom.contentHash && !body.overwrite) {
        throw new ConflictError('You edited this copy since importing it; updating will overwrite your changes', {
          code: 'local_changes',
        });
      }
      skill = await skillRepository.update({ id: target.id, ...content }, { new: true });
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

    res.status(body.targetSkillId ? 200 : 201).json({ skill: { id: String(skill!.id), name: skill!.name } });
  });

export default handler;

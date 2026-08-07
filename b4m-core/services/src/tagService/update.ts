import { IDataLakeRepository, IFabFileRepository, ITagRepository, prefixArmTagNames } from '@bike4mind/common';
import { secureParameters, BadRequestError } from '@bike4mind/utils';
import { z } from 'zod';
import { recomputeLakeStats } from '../dataLakeService/recomputeLakeStats';
import { foldTagName, isDataLakeTagName, normalizeTagName } from './tagName';

const tagUpdateSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).optional(),
  icon: z.string().optional(),
  description: z.string().optional(),
  color: z.string().optional(),
});

export type TagUpdateParams = z.infer<typeof tagUpdateSchema>;

interface TagUpdateAdapters {
  db: {
    tags: Pick<ITagRepository, 'update' | 'findByIdAndUserId' | 'findAllByUserId' | 'delete'>;
    fabFiles: Pick<IFabFileRepository, 'updateTagsByUserId' | 'dedupeTagByUserId' | 'computeDataLakeStats'>;
    dataLakes: Pick<IDataLakeRepository, 'find' | 'setStats' | 'activateIfDraft'>;
  };
}

/**
 * Update a tag document AND, when the name changes, carry the rename onto every file that stored
 * the old name. Writing the document alone left the old string on the files, so the tag read zero
 * files while the Workspaces counts still showed the orphan under its old name.
 *
 * Renaming ONTO a name the user already has merges the two: the renamed document survives (it
 * carries the caller's intended icon/colour/description, and keeping its id is what lets the
 * client's optimistic row update match), and the colliding documents are deleted. A file that
 * carried both names ends up with one entry, not two.
 *
 * A `datalake:` name is refused on either side - see tagService/remove.
 *
 * Either name in a rename can also be a lake's `fileTagPrefix` content tag - membership since
 * #1263 - so renaming a file's every-file-they-own tag out of (or into) a prefix can change which
 * lakes it belongs to. No manage-rights gate is needed for that here, same reasoning as
 * tagService/remove: this call only ever touches files `userId` owns, and prefix-arm membership
 * requires the file's owner to BE the lake's creator, so any lake this could affect was created by
 * this same `userId`. What the rename does NOT do on its own is recompute the affected lakes'
 * stats.
 */
export const update = async (userId: string, params: TagUpdateParams, adapters: TagUpdateAdapters) => {
  const { db } = adapters;
  const { id, ...rest } = secureParameters(params, tagUpdateSchema);

  const tag = await db.tags.findByIdAndUserId(id, userId);

  if (!tag) {
    throw new Error('Tag Service - Update: Tag not found');
  }

  const newName = rest.name === undefined ? undefined : normalizeTagName(rest.name);

  if (isDataLakeTagName(tag.name) || (newName !== undefined && isDataLakeTagName(newName))) {
    throw new BadRequestError('Tag Service - Update: a data lake membership tag cannot be renamed here');
  }

  // Exact comparison, deliberately. The client PUTs the whole tag, so an icon-only or colour-only
  // edit still carries `name` and must not touch a single file; but `foo` -> `Foo` is a real
  // rename, because the files store the old casing.
  const renaming = newName !== undefined && newName !== tag.name;

  if (renaming) {
    const colliders = (await db.tags.findAllByUserId(userId)).filter(
      t => t.id !== tag.id && foldTagName(t.name) === foldTagName(newName)
    );

    // Files before documents. This order converges under retry: if a write below fails, the source
    // document still holds the old name, so re-running the same request finds any straggler.
    // Renaming the document first strands them - the next attempt reads the new name and has
    // nothing left to search for. Not wrapped in a transaction: the rename can touch thousands of
    // files and would hold locks against the 16MB/60s ceiling, and every write here is idempotent.
    await db.fabFiles.updateTagsByUserId(userId, tag.name, newName);

    // Renaming in place is what creates a duplicate, on any file that already carried the target
    // name. Deliberately NOT gated on the rename having moved files this time: if a previous
    // attempt renamed the files and then died here, the retry's rename matches nothing and a
    // count-gated dedupe would skip the duplicate it left behind, stranding it. Its own $expr
    // prefilter makes the no-duplicate case an empty write, so running it every rename is cheap.
    await db.fabFiles.dedupeTagByUserId(userId, newName);

    // Before the update below, not after: the unique index on { userId, name } has no collation, so
    // an exactly-colliding document makes that write fail while this one still exists. There can be
    // more than one collider, for the same reason - `Foo` and `FOO` are separate documents.
    for (const collider of colliders) {
      await db.tags.delete(collider.id);
    }
  }

  const buildData = {
    id,
    ...rest,
    ...(newName === undefined ? {} : { name: newName }),
    updatedAt: new Date(),
  };

  await db.tags.update(buildData);

  // Every usable fileTagPrefix ends in ':' (see prefixArmTagNames), so a colon-free name on
  // both sides of the rename can never touch one - skip the lake lookup for the common case.
  if (renaming && (tag.name.includes(':') || newName.includes(':'))) {
    const candidateLakes = await db.dataLakes.find({ createdByUserId: userId });
    // Either the OLD name mattered to a lake's prefix (a possible leave) or the NEW one does (a
    // possible join) - recompute covers both directions without needing to know which files
    // actually crossed the boundary, matching tagService/remove's reasoning.
    const affectedLakes = candidateLakes.filter(
      lake =>
        prefixArmTagNames([tag.name], lake.fileTagPrefix).length > 0 ||
        prefixArmTagNames([newName], lake.fileTagPrefix).length > 0
    );
    for (const lake of affectedLakes) {
      await recomputeLakeStats(lake, { db });
    }
  }

  return buildData;
};

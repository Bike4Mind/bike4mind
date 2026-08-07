import { secureParameters, BadRequestError } from '@bike4mind/utils';
import { IDataLakeRepository, IFabFileRepository, ITagRepository, matchesTagPrefixArm } from '@bike4mind/common';
import { z } from 'zod';
import { loadPrefixArmCandidateLakes } from '../dataLakeService/prefixArmMembership';
import { recomputeLakeStats } from '../dataLakeService/recomputeLakeStats';
import { isDataLakeTagName } from './tagName';

const tagRemoveSchema = z.object({
  id: z.string(),
});

type TagRemoveParams = z.infer<typeof tagRemoveSchema>;

interface TagRemoveAdapters {
  db: {
    tags: Pick<ITagRepository, 'findByIdAndUserId' | 'delete'>;
    fabFiles: Pick<IFabFileRepository, 'removeTagByUserId' | 'computeDataLakeStats'>;
    dataLakes: Pick<IDataLakeRepository, 'find' | 'setStats' | 'activateIfDraft'>;
  };
}

/**
 * Delete a tag document AND strip its name off every file that carried it. Deleting the document
 * alone left the name orphaned: chips stopped rendering (they intersect tag documents with the
 * file's strings) while the Workspaces tag counts, which read the strings, kept counting it.
 *
 * A `datalake:` name is refused. Membership in a lake IS that string on the file, so stripping one
 * would silently evict every file from the lake. Such a document is reachable - accepting an
 * invite to a shared lake file mints one for the invitee - so this is a real path, not a
 * theoretical one.
 *
 * An ORDINARY name can still be a lake's `fileTagPrefix` content tag, which is membership too
 * (since #1263). No manage-rights gate is needed for THAT signal here, unlike the single-file
 * doors: this call already only ever touches files `userId` owns, and prefix-arm membership
 * requires the file's owner to BE the lake's creator, so any lake this could possibly affect was
 * necessarily created by this same `userId` - the gate would never have anything to refuse. What
 * the bulk strip below does NOT do on its own is recompute the affected lakes' stats.
 */
export const remove = async (userId: string, params: TagRemoveParams, adapters: TagRemoveAdapters) => {
  const { db } = adapters;
  const { id } = secureParameters(params, tagRemoveSchema);

  const tag = await db.tags.findByIdAndUserId(id, userId);

  if (!tag) {
    throw new Error('Tag Service - Delete: Tag not found');
  }

  if (isDataLakeTagName(tag.name)) {
    throw new BadRequestError('Tag Service - Delete: a data lake membership tag cannot be deleted here');
  }

  // Files first, tag document second. This order converges under retry: if the delete below fails,
  // the document still names the tag, so re-running the same request finds the stragglers. The
  // reverse order strands them - the name is gone from the only record that could locate them.
  const filesUpdated = await db.fabFiles.removeTagByUserId(userId, tag.name);

  await db.tags.delete(tag.id);

  // Every usable fileTagPrefix ends in ':' (see prefixArmTagNames), so a colon-free name can never
  // be one - skip the lake lookup entirely for the common plain-tag case.
  if (tag.name.includes(':')) {
    const candidateLakes = await loadPrefixArmCandidateLakes([userId], { db });
    const affectedLakes = candidateLakes.filter(lake => matchesTagPrefixArm([tag.name], lake.fileTagPrefix));
    // Recomputes even for a lake where a surviving sibling tag kept some files members - harmless
    // (the aggregate re-derives the true count either way), and cheaper than re-deriving per file
    // which of these lakes actually lost a member. Independent per-lake recomputes, so run them
    // concurrently rather than one at a time.
    await Promise.all(affectedLakes.map(lake => recomputeLakeStats(lake, { db })));
  }

  return { id: tag.id, name: tag.name, filesUpdated };
};

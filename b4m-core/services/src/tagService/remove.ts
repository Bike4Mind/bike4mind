import { secureParameters, BadRequestError } from '@bike4mind/utils';
import { IFabFileRepository, ITagRepository, isReservedTagPrefix } from '@bike4mind/common';
import { z } from 'zod';

const tagRemoveSchema = z.object({
  id: z.string(),
});

type TagRemoveParams = z.infer<typeof tagRemoveSchema>;

interface TagRemoveAdapters {
  db: {
    tags: Pick<ITagRepository, 'findByIdAndUserId' | 'delete'>;
    fabFiles: Pick<IFabFileRepository, 'removeTagByUserId'>;
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
 */
export const remove = async (userId: string, params: TagRemoveParams, adapters: TagRemoveAdapters) => {
  const { db } = adapters;
  const { id } = secureParameters(params, tagRemoveSchema);

  const tag = await db.tags.findByIdAndUserId(id, userId);

  if (!tag) {
    throw new Error('Tag Service - Delete: Tag not found');
  }

  if (isReservedTagPrefix(tag.name)) {
    throw new BadRequestError('Tag Service - Delete: a data lake membership tag cannot be deleted here');
  }

  // Files first, tag document second. This order converges under retry: if the delete below fails,
  // the document still names the tag, so re-running the same request finds the stragglers. The
  // reverse order strands them - the name is gone from the only record that could locate them.
  const filesUpdated = await db.fabFiles.removeTagByUserId(userId, tag.name);

  await db.tags.delete(tag.id);

  return { id: tag.id, name: tag.name, filesUpdated };
};

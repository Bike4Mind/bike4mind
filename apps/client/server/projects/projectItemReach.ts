import { isOrgServiceAccount, type IUserDocument } from '@bike4mind/common';

type ShareableRepository = {
  shareable: {
    findAllAccessibleByIds: (
      user: Pick<IUserDocument, 'id' | 'groups'>,
      ids: string[]
    ) => Promise<readonly { _id?: unknown; id?: unknown }[]>;
  };
};

/**
 * The project items (`fileIds` / `sessionIds`) the caller may list. A member is listed every item on
 * the strength of the project read alone, as before. An org-owned key is not: a member's personal
 * file or notebook attached to an org-shared project must stay out of its reach, so each item is
 * re-checked against the key's own read arms (owner, org-key grants). Order is preserved.
 */
export async function projectItemIdsReadableBy(
  user: Pick<IUserDocument, 'id' | 'groups' | 'serviceAccountOrganizationId'>,
  ids: string[],
  repository: ShareableRepository
): Promise<string[]> {
  if (!isOrgServiceAccount(user) || ids.length === 0) return ids;
  const readable = await repository.shareable.findAllAccessibleByIds(user, ids);
  const readableIds = new Set(readable.map(item => String(item._id ?? item.id)));
  return ids.filter(id => readableIds.has(id));
}

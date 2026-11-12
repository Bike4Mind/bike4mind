import { isOrgServiceAccount, type IUserDocument, type ProjectResource } from '@bike4mind/common';
import { fabFileRepository, sessionRepository } from '@bike4mind/database';
import { toPublicProject, type PublicProjectSource } from './toPublicProject';

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
type ProjectReader = Pick<IUserDocument, 'id' | 'groups' | 'serviceAccountOrganizationId'>;

export async function projectItemIdsReadableBy(
  user: ProjectReader,
  ids: string[],
  repository: ShareableRepository
): Promise<string[]> {
  if (!isOrgServiceAccount(user) || ids.length === 0) return ids;
  const readable = await repository.shareable.findAllAccessibleByIds(user, ids);
  const readableIds = new Set(readable.map(item => String(item._id ?? item.id)));
  return ids.filter(id => readableIds.has(id));
}

/**
 * toPublicProject for `user`: its `session_ids` / `file_ids` list only the items the caller may read
 * (projectItemIdsReadableBy), so the project payload never names an item the item lists hide.
 */
export async function toPublicProjectFor(user: ProjectReader, project: PublicProjectSource): Promise<ProjectResource> {
  if (!isOrgServiceAccount(user)) return toPublicProject(project);
  const [sessionIds, fileIds] = await Promise.all([
    projectItemIdsReadableBy(user, (project.sessionIds ?? []).map(String), sessionRepository),
    projectItemIdsReadableBy(user, (project.fileIds ?? []).map(String), fabFileRepository),
  ]);
  return toPublicProject({ ...pickPublic(project), sessionIds, fileIds });
}

const pickPublic = (project: PublicProjectSource): PublicProjectSource => ({
  id: project.id,
  name: project.name,
  description: project.description,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});

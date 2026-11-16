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

type ProjectReader = Pick<IUserDocument, 'id' | 'groups' | 'serviceAccountOrganizationId'>;

/**
 * The project items (`fileIds` / `sessionIds`) the caller may list. A member is listed every item on
 * the strength of the project read alone, as before. An org-owned key is not: a member's personal
 * file or notebook attached to an org-shared project must stay out of its reach, so each item is
 * re-checked against the key's own read arms (owner, org-key grants). Order is preserved.
 */
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

type ProjectItems = { sessionIds?: readonly unknown[] | null; fileIds?: readonly unknown[] | null };
type ReadableItemSets = { sessions: ReadonlySet<string>; files: ReadonlySet<string> };

const idsOf = (projects: readonly ProjectItems[], key: keyof ProjectItems): string[] => [
  ...new Set(projects.flatMap(project => (project[key] ?? []).map(String))),
];

/** The readable item ids across a page of projects: one query per item repository, not per project. */
async function readableItemSetsFor(user: ProjectReader, projects: readonly ProjectItems[]): Promise<ReadableItemSets> {
  const [sessions, files] = await Promise.all([
    projectItemIdsReadableBy(user, idsOf(projects, 'sessionIds'), sessionRepository),
    projectItemIdsReadableBy(user, idsOf(projects, 'fileIds'), fabFileRepository),
  ]);
  return { sessions: new Set(sessions), files: new Set(files) };
}

const keepReadable = (ids: readonly unknown[] | null | undefined, readable: ReadonlySet<string>): string[] =>
  (ids ?? []).map(String).filter(id => readable.has(id));

/**
 * A page of project rows for `user` with `sessionIds` / `fileIds` cut to the items the caller may
 * read (projectItemIdsReadableBy). For routes that return the stored row shape (GET /api/projects);
 * rows must be plain objects, since each is spread.
 */
export async function withReadableProjectItems<T extends ProjectItems>(
  user: ProjectReader,
  projects: readonly T[]
): Promise<T[]> {
  if (!isOrgServiceAccount(user)) return [...projects];
  const readable = await readableItemSetsFor(user, projects);
  return projects.map(project => ({
    ...project,
    sessionIds: keepReadable(project.sessionIds, readable.sessions),
    fileIds: keepReadable(project.fileIds, readable.files),
  }));
}

/**
 * toPublicProject for `user`, over a page: `session_ids` / `file_ids` list only the items the caller
 * may read, so the project payload never names an item the item lists hide.
 */
export async function toPublicProjectsFor(
  user: ProjectReader,
  projects: readonly PublicProjectSource[]
): Promise<ProjectResource[]> {
  if (!isOrgServiceAccount(user)) return projects.map(toPublicProject);
  const readable = await readableItemSetsFor(user, projects);
  return projects.map(project =>
    toPublicProject({
      ...pickPublic(project),
      sessionIds: keepReadable(project.sessionIds, readable.sessions),
      fileIds: keepReadable(project.fileIds, readable.files),
    })
  );
}

export async function toPublicProjectFor(user: ProjectReader, project: PublicProjectSource): Promise<ProjectResource> {
  const [resource] = await toPublicProjectsFor(user, [project]);
  return resource;
}

const pickPublic = (project: PublicProjectSource): PublicProjectSource => ({
  id: project.id,
  name: project.name,
  description: project.description,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});

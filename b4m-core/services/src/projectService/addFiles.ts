import {
  IFabFileDocument,
  IFabFileRepository,
  IProjectDocument,
  IProjectRepository,
  IUserDocument,
  Permission,
  ShareableAccessShape,
  grantablePermissions,
  secureParameters,
  BadRequestError,
  NotFoundError,
} from '@bike4mind/common';
import { z } from 'zod';
import { pushShareable } from '../sharingService';
import { distinctIdCount, mergeIds } from '../utils/objectIds';

const addFilesProjectSchema = z.object({
  projectId: z.string().nonempty(),
  fileIds: z.tuple([z.string()], z.string()),
});

type AddFilesProjectParameters = z.infer<typeof addFilesProjectSchema>;

interface AddFilesProjectAdapters {
  db: {
    fabFiles: IFabFileRepository;
    projects: IProjectRepository;
  };
}

export const addFiles = async (
  user: IUserDocument,
  params: AddFilesProjectParameters,
  adapters: AddFilesProjectAdapters
) => {
  const { db } = adapters;
  const { projectId, fileIds } = secureParameters(params, addFilesProjectSchema);
  // Update-level, not read-level: adding files mutates the project and pushes share grants onto
  // the attached files, so a read grant must not reach it. Normalized to a plain object because
  // this predicate returns a hydrated document where findAccessibleById did not.
  const found = await db.projects.shareable.findUpdateAccessById(user, projectId);
  // NotFoundError, not a bare Error: this refusal is routine and user-triggerable - a read-only
  // sharee clicking the button reaches it - and a bare Error is a 500 that pages LiveOps. 404
  // rather than 403 for the same reason every other door in this service answers 404: it does not
  // tell a caller whether a project they cannot reach exists.
  if (!found) throw new NotFoundError('Project not found');

  const project = (
    typeof (found as { toJSON?: unknown }).toJSON === 'function'
      ? (found as unknown as { toJSON: () => IProjectDocument }).toJSON()
      : found
  ) as IProjectDocument;

  const files = await db.fabFiles.shareable.findAllAccessibleByIds(user, fileIds);

  // BadRequestError, not a bare Error: an id the caller cannot reach is a client mistake, and a
  // bare Error is a 500 that pages LiveOps. Reachable now that the repository skips uncastable
  // ids instead of throwing a CastError the handler turned into a 404. Compared against the
  // DEDUPED list, since the reader returns distinct rows and a file sent twice is not one that
  // could not be reached.
  if (files.length !== distinctIdCount(fileIds)) throw new BadRequestError('Some files are not accessible');

  // The ids that RESOLVED, like addSessions: pushing the request list would store `ABC` alongside
  // an existing `abc` as if they were two different files. mergeIds, not uniq, because a row
  // written before ids were canonicalised can ALREADY hold the uppercase form.
  project.fileIds = mergeIds(
    project.fileIds,
    files.map(f => f.id)
  );
  project.updatedAt = new Date();

  // Project write first, gated in its filter: a revoke or delete landing after the read above makes
  // this a 404 before any grant is pushed onto the files.
  const written = await db.projects.updateWithUpdateAccess(user, {
    id: project.id,
    fileIds: project.fileIds,
    updatedAt: project.updatedAt,
  });
  if (!written) throw new NotFoundError('Project not found');

  await updateShareableFiles(user, { project, files }, adapters);

  return project;
};

/**
 * Caps a grant pushed onto `doc` at what `adder` holds on it (its owner holds everything), so adding
 * a file or session you can only read to a project cannot hand the project's members update on it.
 * Returns a filter to call BEFORE pushing: pushShareable mutates `doc.users`, and the adder may be
 * one of the members being pushed.
 */
export const grantCap = (doc: ShareableAccessShape, adder: Pick<IUserDocument, 'id' | 'groups'>) => {
  const grantable = grantablePermissions(doc, adder.id, adder.groups ?? []);
  return (permissions: Permission[]) => permissions.filter(p => grantable.has(p));
};

export const updateShareableFiles = async (
  adder: Pick<IUserDocument, 'id' | 'groups'>,
  params: { project: IProjectDocument; files: IFabFileDocument[] },
  adapters: { db: { fabFiles: IFabFileRepository } }
) => {
  const { project, files } = params;
  const { db } = adapters;

  for (const file of files) {
    const cap = grantCap(file as ShareableAccessShape, adder);
    const push = (userId: string, permissions: Permission[]) => {
      const capped = cap(permissions);
      if (capped.length > 0) pushShareable(file, { userId, permissions: capped, projectId: project.id });
    };

    if (project.userId !== adder.id) push(project.userId, [Permission.read, Permission.update]);

    for (const user of project.users) push(user.userId, user.permissions);

    await db.fabFiles.update({ id: file.id, users: file.users });
  }
};

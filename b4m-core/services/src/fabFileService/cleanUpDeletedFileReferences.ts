import type { IProjectRepository, IUserRepository } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

/**
 * What a delete or unshare leaves to unlink once it has committed: the files, whose system files
 * lose them, and whose projects do. An unshare names no project users - projects are shared, and the
 * file is still live for everyone else in them.
 */
export interface DeletedFileReferences {
  fileIds: string[];
  systemFileUserIds: string[];
  projectUserIds: string[];
}

/** The owner and direct-share recipients of a file - the users a delete cleans up after. */
export const referenceHolderIds = (file: { userId?: unknown; users?: { userId?: unknown }[] | null }): string[] =>
  Array.from(
    new Set(
      [file.userId, ...(file.users ?? []).map(share => share.userId)]
        .filter(id => id !== undefined && id !== null)
        .map(String)
    )
  );

/** Folds several deletes' references into one, so a batch writes once per collection. */
export const mergeDeletedFileReferences = (references: DeletedFileReferences[]): DeletedFileReferences => ({
  fileIds: Array.from(new Set(references.flatMap(r => r.fileIds))),
  systemFileUserIds: Array.from(new Set(references.flatMap(r => r.systemFileUserIds))),
  projectUserIds: Array.from(new Set(references.flatMap(r => r.projectUserIds))),
});

/**
 * Remove deleted or unshared files from the named users' system files and projects. Each write is
 * bounded by an index rather than the unindexed file-id fields; references held through a group or
 * lake share are left to the turn-time scrub (scrubStaleSystemFiles / scrubStaleProjectFiles).
 *
 * MUST run after the delete's transaction has resolved, never inside it: a failed write here would
 * abort the delete, a write conflict would retry it, and transaction sessions do not support
 * parallel operations. The writes run one after another and each is best-effort on its own - the
 * files are already gone, so nothing here may fail the caller.
 */
export const cleanUpDeletedFileReferences = async (
  { fileIds, systemFileUserIds, projectUserIds }: DeletedFileReferences,
  db: {
    users: Pick<IUserRepository, 'pullSystemFilesForUsers'>;
    projects?: Pick<IProjectRepository, 'pullFileReferences'>;
  },
  logger: Logger = Logger.globalInstance
): Promise<void> => {
  if (fileIds.length === 0) return;
  if (systemFileUserIds.length > 0) {
    try {
      await db.users.pullSystemFilesForUsers(systemFileUserIds, fileIds);
    } catch (err) {
      logger.warn('[deleteFabFile] failed to unlink system-file references', { fileIds, err });
    }
  }
  if (projectUserIds.length > 0 && db.projects) {
    try {
      await db.projects.pullFileReferences(fileIds, { userIds: projectUserIds });
    } catch (err) {
      logger.warn('[deleteFabFile] failed to unlink project references', { fileIds, err });
    }
  }
};

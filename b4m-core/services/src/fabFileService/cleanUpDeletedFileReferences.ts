import type { IProjectRepository, ISessionRepository, IUserRepository } from '@bike4mind/common';
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

/** The references a committed delete of `file` leaves behind: every holder's system files and projects. */
export const deletedFileReferences = (file: {
  id: string;
  userId?: unknown;
  users?: { userId?: unknown }[] | null;
}): DeletedFileReferences => {
  const holders = referenceHolderIds(file);
  return { fileIds: [file.id], systemFileUserIds: holders, projectUserIds: holders };
};

/**
 * Groups a batch's per-delete references by the exact holders they name. Folding the three lists
 * independently would build a cross product - one file's id paired with another file's recipients -
 * so a batch holding a deleted file alongside a merely unshared one would pull the unshared file
 * from people who still legitimately hold it.
 */
export const groupDeletedFileReferences = (references: DeletedFileReferences[]): DeletedFileReferences[] => {
  const groups = new Map<string, DeletedFileReferences>();
  for (const reference of references) {
    const key = JSON.stringify([[...reference.systemFileUserIds].sort(), [...reference.projectUserIds].sort()]);
    const group = groups.get(key);
    if (group) {
      group.fileIds.push(...reference.fileIds);
    } else {
      groups.set(key, {
        fileIds: [...reference.fileIds],
        systemFileUserIds: [...reference.systemFileUserIds],
        projectUserIds: [...reference.projectUserIds],
      });
    }
  }
  return Array.from(groups.values());
};

/**
 * Remove deleted or unshared files from the named users' system files, sessions and projects. Each
 * write is bounded by an index rather than the unindexed file-id fields; references held through a
 * group or lake share are left to the turn-time scrub (scrubStaleSystemFiles / scrubStaleProjectFiles).
 *
 * MUST run after the delete's transaction has resolved, never inside it: a failed write here would
 * abort the delete, a write conflict would retry it, and transaction sessions do not support
 * parallel operations. The writes run one after another and each is best-effort on its own - the
 * files are already gone, so nothing here may fail the caller.
 *
 * `sessions` is for the callers whose delete does not already unlink sessions in its own
 * transaction (the delete-all route); a single delete unlinks them fleet-wide before committing.
 */
export const cleanUpDeletedFileReferences = async (
  { fileIds, systemFileUserIds, projectUserIds }: DeletedFileReferences,
  db: {
    users: Pick<IUserRepository, 'pullSystemFilesForUsers'>;
    projects?: Pick<IProjectRepository, 'pullFileReferences'>;
    sessions?: Pick<ISessionRepository, 'pullKnowledgeIdsForUsers'>;
  },
  logger: Logger = Logger.globalInstance
): Promise<void> => {
  if (fileIds.length === 0) return;
  if (systemFileUserIds.length > 0) {
    if (db.sessions) {
      try {
        await db.sessions.pullKnowledgeIdsForUsers(systemFileUserIds, fileIds);
      } catch (err) {
        logger.warn('[cleanUpDeletedFileReferences] failed to unlink session knowledge ids', { fileIds, err });
      }
    }
    try {
      await db.users.pullSystemFilesForUsers(systemFileUserIds, fileIds);
    } catch (err) {
      logger.warn('[cleanUpDeletedFileReferences] failed to unlink system-file references', { fileIds, err });
    }
  }
  if (projectUserIds.length > 0 && db.projects) {
    try {
      await db.projects.pullFileReferences(fileIds, { userIds: projectUserIds });
    } catch (err) {
      logger.warn('[cleanUpDeletedFileReferences] failed to unlink project references', { fileIds, err });
    }
  }
};

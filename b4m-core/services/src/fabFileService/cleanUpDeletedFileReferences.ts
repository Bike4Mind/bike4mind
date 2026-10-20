import type { IProjectRepository, IUserRepository } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

/** What a delete must unlink: the files, and every user who could have referenced them directly. */
export interface DeletedFileReferences {
  fileIds: string[];
  userIds: string[];
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

/**
 * Remove deleted files from the system files and projects of their owner and direct-share
 * recipients - one write per collection, each bounded by an index rather than the unindexed file-id
 * fields. References held through a group or lake share are left to the turn-time scrub
 * (scrubStaleSystemFiles / scrubStaleProjectFiles). Best-effort: the files are already deleted.
 */
export const cleanUpDeletedFileReferences = async (
  { fileIds, userIds }: DeletedFileReferences,
  db: {
    users: Pick<IUserRepository, 'pullSystemFilesForUsers'>;
    projects?: Pick<IProjectRepository, 'pullFileReferences'>;
  },
  logger: Logger = Logger.globalInstance
): Promise<void> => {
  if (fileIds.length === 0 || userIds.length === 0) return;
  try {
    await Promise.all([
      db.users.pullSystemFilesForUsers(userIds, fileIds),
      db.projects?.pullFileReferences(fileIds, { userIds }),
    ]);
  } catch (err) {
    logger.warn('[deleteFabFile] failed to unlink system-file/project references', { fileIds, err });
  }
};

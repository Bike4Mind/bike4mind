import type {
  AttachmentLakeAccess,
  IFabFileRepository,
  IProjectRepository,
  ISessionRepository,
  IUserRepository,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { cleanUpDeletedFileReferences } from '../fabFileService/cleanUpDeletedFileReferences';

/** A user who may have lost read access to some files through a revoke. */
export interface RevokedFileReferenceTarget {
  userId: string;
  fileIds: string[];
}

export interface CleanUpRevokedFileReferencesAdapters {
  db: {
    users: Pick<IUserRepository, 'findById' | 'pullSystemFilesForUsers'>;
    fabFiles: Pick<IFabFileRepository, 'findAccessibleInIds'>;
    sessions: Pick<ISessionRepository, 'pullKnowledgeIdsForUsers'>;
  };
  /** The user's attachment-door lake arms (createAttachmentLakeAccess). */
  resolveAttachmentLakeAccess: (
    user: NonNullable<Awaited<ReturnType<IUserRepository['findById']>>>
  ) => Promise<AttachmentLakeAccess>;
  logger?: Logger;
}

/**
 * After a revoke, drop files from each target user's system files and own sessions - only the ones
 * they can no longer read by any route the chat turn honours (owner, user/group share, global read,
 * data lake). The turn-time scrub deliberately keeps a live file the caller cannot read, so without
 * this the reference warns on every turn and nothing in the UI clears it. Targets may over-include:
 * a file the user still reads is left alone.
 *
 * Run after the revoke has committed (see cleanUpDeletedFileReferences). Best-effort: never throws,
 * and an access check it cannot complete leaves that user's references alone.
 */
export const cleanUpRevokedFileReferences = async (
  targets: RevokedFileReferenceTarget[],
  adapters: CleanUpRevokedFileReferencesAdapters
): Promise<void> => {
  const { db } = adapters;
  const logger = adapters.logger ?? Logger.globalInstance;
  for (const { userId, fileIds } of targets) {
    if (fileIds.length === 0) continue;
    let unreadable: string[];
    try {
      const user = await db.users.findById(userId);
      if (!user) continue;
      const lakeAccess = await adapters.resolveAttachmentLakeAccess(user);
      // An outage cannot prove the lake route gone; stripping a file the user still reads is worse.
      if (lakeAccess.resolutionFailed) continue;
      const readable = await db.fabFiles.findAccessibleInIds(
        fileIds,
        { userId: user.id, userGroups: user.groups ?? undefined },
        lakeAccess
      );
      const readableIds = new Set(readable.map(file => String(file.id)));
      unreadable = fileIds.filter(id => !readableIds.has(id));
    } catch (err) {
      logger.warn('[cleanUpRevokedFileReferences] access check failed; leaving references', { userId, err });
      continue;
    }
    await cleanUpDeletedFileReferences(
      { fileIds: unreadable, systemFileUserIds: [userId], projectUserIds: [] },
      { users: db.users, sessions: db.sessions },
      logger
    );
  }
};

/**
 * Who may lose access to which files when `revokedUserId` leaves or is removed from a project, or -
 * with no `revokedUserId` - when the project is deleted. Read BEFORE the revoke: the cascade
 * (revokeFromProject) prunes the files it unshares from `project.fileIds`.
 *
 * Leaving drops the member's project grants on every project file, and every other participant's
 * grants on the files that member owns. Deleting drops every participant's grants on every file.
 */
export const projectRevokeCleanupTargets = async (
  projectId: string,
  revokedUserId: string | undefined,
  db: {
    projects: Pick<IProjectRepository, 'findById'>;
    fabFiles: Pick<IFabFileRepository, 'findAllByIds'>;
  }
): Promise<RevokedFileReferenceTarget[]> => {
  const project = await db.projects.findById(projectId);
  if (!project) return [];
  const fileIds = (project.fileIds ?? []).map(String);
  const participants = Array.from(new Set([project.userId, ...(project.users ?? []).map(u => u.userId)].map(String)));
  if (!revokedUserId) return participants.map(userId => ({ userId, fileIds }));

  const files = await db.fabFiles.findAllByIds(fileIds);
  const ownedByRevoked = files.filter(file => String(file.userId) === revokedUserId).map(file => String(file.id));
  return [
    { userId: revokedUserId, fileIds },
    ...participants.filter(id => id !== revokedUserId).map(userId => ({ userId, fileIds: ownedByRevoked })),
  ];
};

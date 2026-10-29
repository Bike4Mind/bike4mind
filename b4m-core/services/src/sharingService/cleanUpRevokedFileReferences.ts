import type { AttachmentLakeAccess, IFabFileRepository, ISessionRepository, IUserRepository } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { cleanUpDeletedFileReferences } from '../fabFileService/cleanUpDeletedFileReferences';

/**
 * After a share on a file is revoked, drop the file from the revoked user's system files and own
 * sessions - but only if they can no longer read it by any route the chat turn honours (owner,
 * user/group share, global read, data lake). The turn-time scrub deliberately keeps a live file the
 * caller cannot read, so without this the reference warns on every turn and nothing in the UI clears it.
 *
 * Run after the revoke has committed (see cleanUpDeletedFileReferences). Best-effort: never throws,
 * and an access check it cannot complete leaves the references alone.
 */
export const cleanUpRevokedFileReferences = async (
  fileId: string,
  revokedUserId: string,
  adapters: {
    db: {
      users: Pick<IUserRepository, 'findById' | 'pullSystemFilesForUsers'>;
      fabFiles: Pick<IFabFileRepository, 'findAccessibleInIds'>;
      sessions: Pick<ISessionRepository, 'pullKnowledgeIdsForUsers'>;
    };
    /** The revoked user's attachment-door lake arms (createAttachmentLakeAccess). */
    resolveAttachmentLakeAccess: (
      user: NonNullable<Awaited<ReturnType<IUserRepository['findById']>>>
    ) => Promise<AttachmentLakeAccess>;
    logger?: Logger;
  }
): Promise<void> => {
  const { db } = adapters;
  const logger = adapters.logger ?? Logger.globalInstance;
  try {
    const user = await db.users.findById(revokedUserId);
    if (!user) return;
    const lakeAccess = await adapters.resolveAttachmentLakeAccess(user);
    // An outage cannot prove the lake route gone; stripping a file the user still reads is worse.
    if (lakeAccess.resolutionFailed) return;
    const stillReadable = await db.fabFiles.findAccessibleInIds(
      [fileId],
      { userId: user.id, userGroups: user.groups ?? undefined },
      lakeAccess
    );
    if (stillReadable.length > 0) return;
  } catch (err) {
    logger.warn('[cleanUpRevokedFileReferences] access check failed; leaving references', { fileId, err });
    return;
  }
  await cleanUpDeletedFileReferences(
    { fileIds: [fileId], systemFileUserIds: [revokedUserId], projectUserIds: [] },
    { users: db.users, sessions: db.sessions },
    logger
  );
};

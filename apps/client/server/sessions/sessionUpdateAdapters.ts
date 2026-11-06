import type { IUserDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { projectRepository, sessionRepository, fabFileRepository, cacheRepository } from '@bike4mind/database';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import type { resolveRetrievalLakeScope } from '@server/dataLakes/resolveRetrievalLakeScope';

/** Adapters for sessionService.updateSession, shared by PUT /api/sessions/[id] and the bulk tag write. */
export const buildSessionUpdateAdapters = (
  req: Parameters<typeof resolveRetrievalLakeScope>[0],
  user: IUserDocument,
  logger: Logger
) => ({
  db: {
    sessions: sessionRepository,
    projects: projectRepository,
    fabFiles: fabFileRepository,
    caches: cacheRepository,
  },
  logger,
  // Lets the lake-tag derivation see lake-membership files: the ownership reader alone cannot,
  // so attaching a teammate's org-lake file would otherwise derive nothing and leave the
  // session unscoped. Same resolver the chat tool runs on, so the two cannot drift.
  // Imported at CALL time - see the create route for why (the resolver's graph reaches the
  // Mongoose models, and it is only needed when files are actually attached).
  resolveLakeAccess: async () =>
    (await import('@server/dataLakes/resolveRetrievalLakeScope')).resolveRetrievalLakeScope(req),
  // The attachment door's lake arms, so an added lake file passes the access check.
  resolveAttachmentLakeAccess: async () =>
    (await import('@server/dataLakes/attachmentLakeAccess')).createAttachmentLakeAccess(user, logger)(),
  storage: getFilesStorage(),
});

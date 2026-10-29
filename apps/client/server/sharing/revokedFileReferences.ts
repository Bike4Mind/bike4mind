import type { Logger } from '@bike4mind/observability';
import { fabFileRepository, projectRepository, sessionRepository, userRepository } from '@bike4mind/database';
import { sharingService } from '@bike4mind/services';

/**
 * The routes' wiring for sharingService.cleanUpRevokedFileReferences. Call it after the revoke's
 * transaction has committed; it never throws.
 */
export const cleanUpRevokedFileReferences = (targets: sharingService.RevokedFileReferenceTarget[], logger: Logger) =>
  sharingService.cleanUpRevokedFileReferences(targets, {
    db: { users: userRepository, fabFiles: fabFileRepository, sessions: sessionRepository },
    // Imported at call time, like the session routes: the resolver's graph reaches the Mongoose models.
    // requireCompleteView: a lake view narrowed by an outage must not read as "no longer reachable".
    resolveAttachmentLakeAccess: async user =>
      (await import('@server/dataLakes/attachmentLakeAccess')).createAttachmentLakeAccess(user, logger, {
        requireCompleteView: true,
      })(),
    logger,
  });

/**
 * projectRevokeCleanupTargets for the routes. Read before the revoke runs; a failed read only means
 * no cleanup, so it never fails the request.
 */
export const projectRevokeCleanupTargets = (projectId: string, revokedUserId: string | undefined, logger: Logger) =>
  sharingService
    .projectRevokeCleanupTargets(projectId, revokedUserId, { projects: projectRepository, fabFiles: fabFileRepository })
    .catch(err => {
      logger.warn('[projectRevokeCleanupTargets] could not read the project; skipping reference cleanup', {
        projectId,
        err,
      });
      return [];
    });

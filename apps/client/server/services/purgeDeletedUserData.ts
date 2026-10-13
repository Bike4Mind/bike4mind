import { User, embedConversationRepository, hideDeletedAuthorAnnotations } from '@bike4mind/database';
import type { IUserDocument } from '@bike4mind/common';
import { purgeUserPublishedArtifacts } from '@server/services/publish/purgeUserPublishedArtifacts';
import { decryptStoredToken, revokeDriveGrant } from '@server/integrations/google/drive/common';
import { flagConnectionsStoppedByDisconnect } from '@server/integrations/google/drive/flagConnectionsStoppedByDisconnect';
import { revokeAtlassianGrant } from '@server/integrations/jira/revokeAtlassianGrant';

interface MinimalLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/** The third-party OAuth credentials a user row holds. Read them BEFORE the delete: the row is gone after. */
export type UserIntegrationGrants = Pick<IUserDocument, 'googleDrive' | 'atlassianConnect'>;

/**
 * Read straight from the DB, not a copy captured earlier in the request: a token refresh rotates the
 * stored value, and revoking a stale copy could revoke nothing.
 */
export async function readUserIntegrationGrants(userId: string): Promise<UserIntegrationGrants | null> {
  return User.findById(userId, 'googleDrive atlassianConnect').lean<UserIntegrationGrants>();
}

/**
 * Remove the data a deleted account leaves behind that nothing else would ever reach. Call it
 * from every path that deletes a user, AFTER the delete has been authorized and committed.
 *
 * Each step is best-effort and independent: the account is already gone, so one failure must
 * not skip the others or surface as an error a retry cannot fix. Every step is idempotent, so
 * re-running this for the same id is safe. Backstops for a failed step: the embed collection's
 * TTL index, the publish serve route refusing artifacts whose owner no longer exists, and the
 * orphan backfill (packages/scripts/src/backfillOrphanedPublishedArtifacts.ts) for annotations.
 */
export async function purgeDeletedUserData(
  userId: string,
  {
    deletedBy,
    logger,
    integrationGrants,
  }: { deletedBy: string; logger: MinimalLogger; integrationGrants: UserIntegrationGrants | null }
): Promise<void> {
  try {
    await embedConversationRepository.deleteAllForUser(userId);
  } catch (err) {
    logger.error(`Failed to purge embed conversations for deleted user ${userId}: ${String(err)}`);
  }

  try {
    await purgeUserPublishedArtifacts(userId, { deletedBy, logger });
  } catch (err) {
    logger.error(`Failed to purge published artifacts for deleted user ${userId}: ${String(err)}`);
  }

  // After the artifact purge, so this only catches what the user wrote on pages that stay live.
  try {
    const hidden = await hideDeletedAuthorAnnotations(userId);
    logger.info(`Hid ${hidden} annotation(s) written by deleted user ${userId}`);
  } catch (err) {
    logger.error(`Failed to hide annotations for deleted user ${userId}: ${String(err)}`);
  }

  // Last: the revokes call out to the providers, and a slow provider must not cost the local steps above.
  if (integrationGrants) {
    await revokeIntegrationGrants(userId, integrationGrants, logger);
  }
}

/**
 * Our copy of the credentials died with the row, but the grants stay live at the provider until
 * revoked. Same policy as the profile disconnects: revoke, then flag the Drive connections that were
 * syncing on the grant (org ones copy the user's refresh token) so they stop visibly.
 */
async function revokeIntegrationGrants(
  userId: string,
  { googleDrive, atlassianConnect }: UserIntegrationGrants,
  logger: MinimalLogger
): Promise<void> {
  const context = `deleted user ${userId}`;

  if (googleDrive) {
    try {
      // The refresh token when there is one: revoking it ends the whole grant, not just one access token.
      await revokeDriveGrant(googleDrive.refreshToken || googleDrive.accessToken, context);
      const affected = await flagConnectionsStoppedByDisconnect(userId, decryptStoredToken(googleDrive.refreshToken));
      logger.info(
        `Flagged ${affected.affectedOrgConnections} org and ${affected.affectedPersonalConnections} personal Drive connection(s) for deleted user ${userId}`
      );
    } catch (err) {
      logger.error(`Failed to revoke the Google Drive grant for deleted user ${userId}: ${String(err)}`);
    }
  }

  try {
    await revokeAtlassianGrant(atlassianConnect?.accessToken, context);
  } catch (err) {
    logger.error(`Failed to revoke the Atlassian grant for deleted user ${userId}: ${String(err)}`);
  }
}

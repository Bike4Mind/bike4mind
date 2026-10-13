import { orgGoogleDriveConnectionRepository } from '@bike4mind/database';
import { decryptStoredToken } from '@server/integrations/google/drive/common';
import { driveConnectionOwnerOf, type IOrgGoogleDriveConnectionDocument } from '@bike4mind/common';

/**
 * The org Drive connections that the just-revoked token actually kills.
 *
 * The connect flow copies `User.googleDrive.refreshToken` VERBATIM as the connection's org-owned
 * credential (see readUserDriveCredential in data-lakes/drive-sync.ts), so revoking here necessarily
 * kills those connections too. We revoke anyway: a user asking us to drop their Google access must
 * win over an org's convenience. What we owe them is that the breakage is VISIBLE rather than a
 * scheduled re-sync that quietly starts failing - which is what this does. `credential_error` is the
 * exact state (the stored credential no longer authenticates); the remedy is an org owner/manager
 * re-running Connect, which rewrites the credential. The caller does the flagging.
 *
 * Matched on the TOKEN, not on `connectedBy` alone: a connection can still hold an older refresh
 * token of the same user, which is a separate grant at Google and survives this revoke. Flagging that
 * one would stop a sync that still works, since findDueForPoll skips `credential_error`.
 */
async function orgConnectionsUsingRevokedToken(
  connections: IOrgGoogleDriveConnectionDocument[],
  revokedToken: string | null
): Promise<IOrgGoogleDriveConnectionDocument[]> {
  if (!revokedToken) return [];

  // Per-connection credential read: the token is select:false, and the accessor is owner-scoped by
  // design, so it cannot be batched into one query. This runs on an interactive disconnect over the
  // handful of folders one user connected.
  const killed = await Promise.all(
    connections.map(async connection => {
      const withCredentials = await orgGoogleDriveConnectionRepository.findByIdWithCredentials(
        connection.id,
        driveConnectionOwnerOf(connection)
      );
      return decryptStoredToken(withCredentials?.oauthRefreshToken) === revokedToken ? connection : null;
    })
  );
  return killed.filter((connection): connection is IOrgGoogleDriveConnectionDocument => connection !== null);
}

/**
 * Flag every Drive connection a revoke of `userId`'s Google grant stops, split by kind for the caller's
 * warning. Shared by the profile disconnect (pages/api/google-drive/disconnect.ts) and account deletion
 * (server/services/purgeDeletedUserData.ts); both revoke, so both owe the org the visible stop.
 *
 * ORG connections are matched on the revoked token (see orgConnectionsUsingRevokedToken). A PERSONAL
 * connection keeps no token of its own and syncs on this user's live grant, which the disconnect
 * removes outright, so every one of them stops whichever token was revoked - flagging them is what
 * makes the stop clean (the poll skips `credential_error`) instead of a run that fails each hour.
 * Re-linking Google Drive and re-running Connect on the lake heals them (updateCredential).
 */
export async function flagConnectionsStoppedByDisconnect(
  userId: string,
  revokedToken: string | null
): Promise<{ affectedOrgConnections: number; affectedPersonalConnections: number }> {
  const connections = await orgGoogleDriveConnectionRepository.findByConnectedBy(userId);
  const personal = connections.filter(connection => !connection.organizationId);
  const org = await orgConnectionsUsingRevokedToken(
    connections.filter(connection => !!connection.organizationId),
    revokedToken
  );

  await Promise.all([
    ...org.map(connection =>
      orgGoogleDriveConnectionRepository.updateHealth(connection.id, {
        status: 'credential_error',
        lastError:
          'The Google account that authorized this folder was disconnected. Reconnect the folder to resume syncing.',
      })
    ),
    ...personal.map(connection =>
      orgGoogleDriveConnectionRepository.updateHealth(connection.id, {
        status: 'credential_error',
        lastError: 'Google Drive was unlinked from your profile. Link it again, then reconnect the folder.',
      })
    ),
  ]);
  return { affectedOrgConnections: org.length, affectedPersonalConnections: personal.length };
}

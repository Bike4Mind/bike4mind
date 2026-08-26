import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { User, orgGoogleDriveConnectionRepository } from '@bike4mind/database';
import { BadRequestError } from '@server/utils/errors';
import { decryptStoredToken, revokeDriveGrant } from '@server/integrations/google/drive/common';

/**
 * Mark every org Drive connection that the just-revoked token actually kills.
 *
 * The connect flow copies `User.googleDrive.refreshToken` VERBATIM as the connection's org-owned
 * credential (see captureOrgCredential in data-lakes/drive-sync.ts), so revoking here necessarily
 * kills those connections too. We revoke anyway: a user asking us to drop their Google access must
 * win over an org's convenience. What we owe them is that the breakage is VISIBLE rather than a
 * scheduled re-sync that quietly starts failing - which is what this does. `credential_error` is the
 * exact state (the stored credential no longer authenticates); the remedy is an org owner/manager
 * re-running Connect, which rewrites the credential.
 *
 * Matched on the TOKEN, not on `connectedBy` alone: a connection can still hold an older refresh
 * token of the same user, which is a separate grant at Google and survives this revoke. Flagging that
 * one would stop a sync that still works, since findDueForPoll skips `credential_error`.
 *
 * Returns how many connections were flagged so the caller can warn the user.
 */
async function flagConnectionsUsingRevokedToken(userId: string, revokedToken: string | null): Promise<number> {
  if (!revokedToken) return 0;

  const connections = await orgGoogleDriveConnectionRepository.findByConnectedBy(userId);
  // Per-connection credential read: the token is select:false, and the accessor is org-scoped by
  // design, so it cannot be batched into one query. This runs on an interactive disconnect over the
  // handful of folders one user connected.
  const killed = await Promise.all(
    connections.map(async connection => {
      const withCredentials = await orgGoogleDriveConnectionRepository.findByIdWithCredentials(
        connection.id,
        connection.organizationId
      );
      return decryptStoredToken(withCredentials?.oauthRefreshToken) === revokedToken ? connection : null;
    })
  );

  const affected = killed.filter((connection): connection is (typeof connections)[number] => connection !== null);
  await Promise.all(
    affected.map(connection =>
      orgGoogleDriveConnectionRepository.updateHealth(connection.id, {
        status: 'credential_error',
        lastError:
          'The Google account that authorized this folder was disconnected. Reconnect the folder to resume syncing.',
      })
    )
  );
  return affected.length;
}

/**
 * DELETE /api/google-drive/disconnect -> 200 { affectedOrgConnections }
 *
 * Revokes the grant at Google and then drops the local record. Order matters: nulling `googleDrive`
 * first would leave nothing to revoke WITH if the revoke did not go through, so the grant would stay
 * live at Google with no path back to it. Revoke first (best-effort - it never throws, see
 * revokeDriveGrant), delete after, so a failed revoke is retryable by disconnecting again.
 */
const handler = baseApi().delete(
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    // Read the credential from the DB, not `req.user`: a token refresh (token.ts, or any Drive call
    // through getValidUserDriveAccessToken) rotates the stored value, and revoking a copy captured
    // when the request was authenticated could revoke nothing.
    const user = await User.findById(userId, 'googleDrive');
    const googleDrive = user?.googleDrive;
    if (!googleDrive) {
      throw new BadRequestError('You do not have Google Drive connected');
    }

    // The refresh token, NOT the access token: revoking a refresh token revokes the authorization
    // grant and cascades to every access token minted from it, so it is the only revoke that actually
    // ends our access. Unconditional - an expired access token says nothing about the grant, which
    // outlives it; the old `!isAccessTokenExpired` guard is exactly why a stale connection never got
    // revoked. Falls back to the access token only when no refresh token was ever stored (a repeat
    // authorization before `prompt: 'consent'` landed), where killing that token is all we can do.
    const storedToken = googleDrive.refreshToken || googleDrive.accessToken;
    await revokeDriveGrant(storedToken, `user ${userId}`);

    // Before the local delete, so a Mongo failure here leaves the user still reading "connected" and
    // able to retry (the retry's revoke is idempotent - Google answers invalid_token). Nulling first
    // and failing here would leave the org connections reading healthy on a credential that is dead,
    // with nothing left to drive a second attempt.
    //
    // Only the refresh token identifies a grant that org connections could be sharing; the access-token
    // fallback above kills one token and nothing downstream, so it flags nothing (and an org connection
    // cannot exist without a refresh token - captureOrgCredential requires one).
    const affectedOrgConnections = await flagConnectionsUsingRevokedToken(
      userId,
      googleDrive.refreshToken ? decryptStoredToken(googleDrive.refreshToken) : null
    );

    await User.findByIdAndUpdate(userId, {
      googleDrive: null,
    });

    return res.status(200).json({ affectedOrgConnections });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { User } from '@bike4mind/database';
import { BadRequestError } from '@server/utils/errors';
import { decryptStoredToken, revokeDriveGrant } from '@server/integrations/google/drive/common';
import { flagConnectionsStoppedByDisconnect } from '@server/integrations/google/drive/flagConnectionsStoppedByDisconnect';

/**
 * DELETE /api/google-drive/disconnect -> 200 { affectedOrgConnections, affectedPersonalConnections }
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
    // fallback above kills one token and no org connection (one cannot exist without a refresh token -
    // readUserDriveCredential requires one). Personal connections stop either way.
    const affected = await flagConnectionsStoppedByDisconnect(
      userId,
      googleDrive.refreshToken ? decryptStoredToken(googleDrive.refreshToken) : null
    );

    await User.findByIdAndUpdate(userId, {
      googleDrive: null,
    });

    return res.status(200).json(affected);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

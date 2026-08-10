import { Config } from '@server/utils/config';
import { google } from 'googleapis';
import dayjs from 'dayjs';
import { User, orgGoogleDriveConnectionRepository } from '@bike4mind/database';
import { encryptToken, decryptToken } from '@server/security/tokenEncryption';
import { BadRequestError } from '@server/utils/errors';

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

const REDIRECT_URI = `${process.env.APP_URL}/google-drive/callback`;

const oauth2Client = new google.auth.OAuth2(Config.GOOGLE_CLIENT_ID, Config.GOOGLE_CLIENT_SECRET, REDIRECT_URI);

export function getAuthUrl(): string {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
}

export async function getTokens(code: string) {
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

export async function refreshAccessToken(refreshToken: string) {
  // Fresh client per call - NEVER the shared module-level `oauth2Client`. google-auth-library
  // re-reads `refresh_token` off the client's mutable `credentials` AFTER the network await, so a
  // concurrent refresh for another user racing on the shared singleton can cross-write one user's
  // refresh token into another user's persisted record (same hazard createDriveClient avoids).
  const client = new google.auth.OAuth2(Config.GOOGLE_CLIENT_ID, Config.GOOGLE_CLIENT_SECRET, REDIRECT_URI);
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();
  return credentials;
}

export async function revokeToken(accessToken: string) {
  await oauth2Client.revokeToken(accessToken);
}

/**
 * Resolve a valid Google Drive access token for a user from their stored (encrypted) OAuth
 * credential, refreshing + persisting it if expired. Throws if the user has no connection or the
 * refresh fails - the caller decides whether to surface a re-auth prompt.
 *
 * NOTE: `pages/api/google-drive/token.ts` has parallel inline logic tuned to return an authUrl on
 * failure for the browser attach flow; this helper is the throw-on-failure form for server jobs.
 * Keep the two in sync if the refresh/persist shape changes.
 */
export async function getValidUserDriveAccessToken(userId: string): Promise<string> {
  const user = await User.findById(userId, 'googleDrive');
  // Expected user states (not connected / needs reconnect) are BadRequestError, not bare Error:
  // errorHandler only maps status-bearing errors, so a bare Error here becomes a 500 logged at
  // `error` level, which trips the LiveOps CloudWatch filter for the most common non-error state.
  if (!user?.googleDrive) throw new BadRequestError('Google Drive not connected');

  const { accessToken: rawAccess, refreshToken: rawRefresh, expiresAt } = user.googleDrive;
  // A corrupt/undecryptable CACHED access token must not hard-fail - fall through to the refresh
  // path, which can still succeed from the refresh token.
  let accessToken: string | null = null;
  try {
    accessToken = decryptToken(rawAccess);
  } catch {
    accessToken = null;
  }
  const isExpired = !expiresAt || dayjs().isAfter(dayjs(expiresAt));
  if (!isExpired && accessToken) return accessToken;

  // Same corrupt-credential shape as the cached access token: an undecryptable refresh token
  // (post key-rotation / partial restore) must be a reconnect (400), not a bare Error -> 500.
  let refreshToken: string | null = null;
  try {
    refreshToken = decryptToken(rawRefresh);
  } catch {
    refreshToken = null;
  }
  if (!refreshToken) throw new BadRequestError('Google Drive refresh token unreadable - reconnect required');

  const credentials = await refreshAccessToken(refreshToken);
  if (!credentials.access_token) throw new BadRequestError('Google Drive token refresh returned no access token');

  await User.updateOne(
    { _id: userId },
    {
      'googleDrive.accessToken': encryptToken(credentials.access_token)!,
      'googleDrive.refreshToken': credentials.refresh_token ? encryptToken(credentials.refresh_token)! : rawRefresh,
      // expiresAt is `required`, so it must be a real Date - both `null` AND an absent ($unset) path
      // fail the validator on the next user.save() (e.g. the websocket connect handler). When Google
      // omits expiry_date, write epoch: it satisfies `required` and `dayjs().isAfter(epoch)` reads as
      // already-expired, so the next call refreshes.
      'googleDrive.expiresAt': credentials.expiry_date ? new Date(credentials.expiry_date) : new Date(0),
    }
  );

  return credentials.access_token;
}

/**
 * Resolve a valid Drive access token for an ORG connection (the ingest job's credential).
 *
 * Prefers the connection's own org-owned refresh token; until the org-owned connect flow (issue D)
 * populates it, falls back to the connecting user's personal Drive credential (`connectedBy`). On a
 * credential failure it marks the connection `credential_error` so the failure is observable rather
 * than silent. Loads the encrypted token via the credential-scoped accessor, never a default read.
 */
export async function getValidConnectionDriveAccessToken(connectionId: string): Promise<string> {
  const connection = await orgGoogleDriveConnectionRepository.findByIdWithCredentials(connectionId);
  if (!connection) throw new Error('Google Drive connection not found');

  if (connection.oauthRefreshToken) {
    try {
      const refreshToken = decryptToken(connection.oauthRefreshToken);
      if (refreshToken) {
        const credentials = await refreshAccessToken(refreshToken);
        if (credentials.access_token) return credentials.access_token;
      }
    } catch (e) {
      await orgGoogleDriveConnectionRepository.updateHealth(connection.id, {
        status: 'credential_error',
        lastError: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }

  // Fallback: the connecting user's personal Drive token (today's connect flow stores there).
  return getValidUserDriveAccessToken(connection.connectedBy);
}

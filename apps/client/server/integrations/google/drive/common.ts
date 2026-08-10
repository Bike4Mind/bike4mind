import { Config } from '@server/utils/config';
import { google } from 'googleapis';
import dayjs from 'dayjs';
import { User } from '@bike4mind/database';
import { encryptToken, decryptToken } from '@server/security/tokenEncryption';

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
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauth2Client.refreshAccessToken();
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
  if (!user?.googleDrive) throw new Error('Google Drive not connected');

  const { accessToken: rawAccess, refreshToken: rawRefresh, expiresAt } = user.googleDrive;
  const accessToken = decryptToken(rawAccess);
  const isExpired = !expiresAt || dayjs().isAfter(dayjs(expiresAt));
  if (!isExpired && accessToken) return accessToken;

  const refreshToken = decryptToken(rawRefresh);
  if (!refreshToken) throw new Error('Google Drive refresh token missing - reconnect required');

  const credentials = await refreshAccessToken(refreshToken);
  if (!credentials.access_token) throw new Error('Google Drive token refresh returned no access token');

  await User.updateOne(
    { _id: userId },
    {
      'googleDrive.accessToken': encryptToken(credentials.access_token)!,
      'googleDrive.refreshToken': credentials.refresh_token ? encryptToken(credentials.refresh_token)! : rawRefresh,
      'googleDrive.expiresAt': credentials.expiry_date ? new Date(credentials.expiry_date) : undefined,
    }
  );

  return credentials.access_token;
}

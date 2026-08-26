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
    // Force the consent screen so Google ALWAYS returns a refresh_token. With `access_type: offline`
    // alone, a REPEAT authorization omits refresh_token and the callback persists
    // `refreshToken: undefined` - survivable for a short-lived personal session, but fatal for an
    // org-owned connection, which copies this token as its durable credential (see drive-sync.ts) and
    // must keep syncing after the connecting user's access token expires or they leave the org.
    prompt: 'consent',
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

/** Outcome of a grant revocation attempt. `already_invalid` and `revoked` both mean nothing is live at Google. */
export type RevokeOutcome = 'revoked' | 'already_invalid' | 'no_credential' | 'failed';

/**
 * Revoke a stored (encrypted) Google credential at Google, BEST EFFORT.
 *
 * Prefer handing this the REFRESH token: Google revokes the whole authorization grant, which
 * cascades to every access token minted from it. Revoking an access token only kills that one token
 * and leaves the grant (and its refresh token) live - which is why the caller must not fall back to
 * the access token when a refresh token exists.
 *
 * Never throws. Local teardown must still complete when Google is unreachable, otherwise a provider
 * outage leaves BOTH a live grant at Google AND our stored copy of the credential; dropping our copy
 * is strictly better, and the user's own Google account page remains the backstop for the grant. The
 * console lines are the only way a smoke test can tell "never attempted" from "attempted and
 * swallowed", so every arm logs.
 */
export async function revokeDriveGrant(
  encryptedToken: string | null | undefined,
  context: string
): Promise<RevokeOutcome> {
  if (!encryptedToken) {
    console.warn(`[googleDrive] revoke skipped (${context}): no stored credential`);
    return 'no_credential';
  }

  let token: string | null;
  try {
    token = decryptToken(encryptedToken);
  } catch (e) {
    // Undecryptable (post key-rotation / partial restore): the grant is unreachable from here, so
    // say so loudly rather than reporting a revoke that never happened.
    console.error(`[googleDrive] revoke failed (${context}): stored credential is unreadable`, e);
    return 'failed';
  }
  if (!token) {
    console.warn(`[googleDrive] revoke skipped (${context}): stored credential decrypted to empty`);
    return 'no_credential';
  }

  try {
    await revokeToken(token);
    console.log(`[googleDrive] revoked grant at Google (${context})`);
    return 'revoked';
  } catch (e) {
    // A token Google no longer recognises (already revoked, or expired past its grant) leaves nothing
    // live - the desired end state, not a failure to retry.
    if (isUnknownTokenError(e)) {
      console.log(`[googleDrive] revoke no-op (${context}): Google no longer recognises the token`);
      return 'already_invalid';
    }
    console.error(`[googleDrive] revoke failed (${context}) - the grant may still be live at Google`, e);
    return 'failed';
  }
}

/**
 * Google's revoke endpoint answers 400 both for a token it does not recognise (`invalid_token`) and
 * for a request WE malformed (`invalid_request`). Only the former means "nothing left to revoke";
 * matching on the status alone would let our own bad request read as a successful revocation, which
 * is the exact failure mode that made this revoke a silent no-op in the first place.
 */
function isUnknownTokenError(e: unknown): boolean {
  const err = e as { response?: { status?: number; data?: { error?: string } }; status?: number };
  const status = err?.response?.status ?? err?.status;
  return status === 400 && err?.response?.data?.error === 'invalid_token';
}

/**
 * Decrypt a stored token for COMPARISON only - never throws, because an unreadable value simply has
 * no identity to compare. Use revokeDriveGrant (which logs) when the decrypt outcome itself matters.
 */
export function decryptStoredToken(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return decryptToken(value);
  } catch {
    return null;
  }
}

/** The user's own decrypted Drive refresh token, or null when they have no readable connection. */
async function personalRefreshTokenOf(userId: string): Promise<string | null> {
  const user = await User.findById(userId, 'googleDrive');
  return decryptStoredToken(user?.googleDrive?.refreshToken);
}

/**
 * Tear down an org Drive connection: revoke its org-owned credential at Google (unless it is BORROWED
 * - see below), then hard-delete the row, which releases the global driveFolderId claim.
 *
 * This is the single teardown seam on purpose - the revoke belongs to *releasing a connection*, not to
 * one route. `release()` itself cannot do it: the crypto helpers live in apps/client and are not
 * reachable from packages/database (same reason the encrypt guard lives at the writer). Any future
 * caller that tears a connection down - lake purge included - must come through here, or it strands a
 * live Google grant behind a credential no product surface can reach any more.
 *
 * Revoke-before-delete, so if the revoke is the step that fails the credential is still there to retry
 * from; the revoke is best-effort, so an unreachable Google never blocks the disconnect.
 *
 * BORROWED credential: drive-sync copies the connecting user's personal refresh token verbatim, so the
 * org's credential is usually the same token that user still holds. Revoking it would kill THEIR
 * personal Drive (picker, attachments) from an org admin's click, leaving their profile still reading
 * "connected" - reaching well past the org resource being disconnected. In that case deleting the row
 * IS the full teardown of the org's copy, and the grant stays the user's to revoke from their own
 * profile (which now genuinely revokes). A credential the user no longer holds has no such owner, so
 * this connection is its last live handle and it does get revoked.
 */
export async function releaseDriveConnection(connectionId: string, organizationId: string): Promise<boolean> {
  const connection = await orgGoogleDriveConnectionRepository.findByIdWithCredentials(connectionId, organizationId);
  if (!connection) return false;

  const connectionToken = decryptStoredToken(connection.oauthRefreshToken);
  const isBorrowed = !!connectionToken && connectionToken === (await personalRefreshTokenOf(connection.connectedBy));
  if (isBorrowed) {
    console.log(
      `[googleDrive] revoke skipped (org connection ${connectionId}): credential is the connecting user's own personal Drive token - dropping the org copy only`
    );
  } else {
    await revokeDriveGrant(connection.oauthRefreshToken, `org connection ${connectionId}`);
  }

  return orgGoogleDriveConnectionRepository.release(connectionId, organizationId);
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
 * than silent. Loads the encrypted token via the org-scoped credential accessor (the caller passes
 * the connection's organizationId), never a default read.
 */
export async function getValidConnectionDriveAccessToken(
  connectionId: string,
  organizationId: string
): Promise<string> {
  const connection = await orgGoogleDriveConnectionRepository.findByIdWithCredentials(connectionId, organizationId);
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

import { Logger } from '@bike4mind/observability';
import { getAtlassianOAuthConfig } from './atlassianConfig';
import { decryptToken } from '../../security/tokenEncryption';

const ATLASSIAN_REVOKE_URL = 'https://auth.atlassian.com/oauth/token/revoke';
// Well inside the 60s server Lambda timeout, so a stalled provider cannot take the caller down with it.
const REVOKE_TIMEOUT_MS = 10_000;

export type AtlassianRevokeOutcome = 'revoked' | 'no_credential' | 'not_configured' | 'failed';

/**
 * Revoke a stored (encrypted) Atlassian OAuth token at Atlassian, BEST EFFORT.
 *
 * Never throws: callers revoke on the way to dropping their own copy of the credential (disconnect,
 * account deletion), and an Atlassian outage must not block that local teardown. Mirrors
 * revokeDriveGrant in packages/server-utils/src/integrations/google/drive/common.ts; keep the two contracts in sync.
 */
export async function revokeAtlassianGrant(
  encryptedToken: string | null | undefined,
  context: string
): Promise<AtlassianRevokeOutcome> {
  if (!encryptedToken) {
    return 'no_credential';
  }

  try {
    const token = decryptToken(encryptedToken);
    if (!token) {
      Logger.warn('[atlassian] revoke skipped: stored credential decrypted to empty', { context });
      return 'no_credential';
    }

    const { clientId, clientSecret } = await getAtlassianOAuthConfig();
    if (!clientId || !clientSecret) {
      Logger.warn('[atlassian] revoke skipped: OAuth client is not configured', { context });
      return 'not_configured';
    }

    const response = await fetch(ATLASSIAN_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, token }),
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Release the connection without reading the upstream payload into memory or logs.
      try {
        await response.body?.cancel();
      } catch (error) {
        Logger.warn('[atlassian] failed to release revoke response', { context, error });
      }
      Logger.warn('[atlassian] revoke failed', { context, status: response.status });
      return 'failed';
    }

    Logger.info('[atlassian] revoked token at Atlassian', { context });
    return 'revoked';
  } catch (e) {
    Logger.error('[atlassian] revoke failed - the token may still be live at Atlassian', { context, error: e });
    return 'failed';
  }
}

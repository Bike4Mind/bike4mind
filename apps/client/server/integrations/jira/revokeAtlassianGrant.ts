import { getAtlassianOAuthConfig } from '@server/integrations/jira/atlassianConfig';
import { decryptToken } from '@server/security/tokenEncryption';

const ATLASSIAN_REVOKE_URL = 'https://auth.atlassian.com/oauth/token/revoke';
// Well inside the 60s server Lambda timeout, so a stalled provider cannot take the caller down with it.
const REVOKE_TIMEOUT_MS = 10_000;

export type AtlassianRevokeOutcome = 'revoked' | 'no_credential' | 'not_configured' | 'failed';

/**
 * Revoke a stored (encrypted) Atlassian OAuth token at Atlassian, BEST EFFORT.
 *
 * Never throws: callers revoke on the way to dropping their own copy of the credential (disconnect,
 * account deletion), and an Atlassian outage must not block that local teardown. Mirrors
 * revokeDriveGrant in server/integrations/google/drive/common.ts; keep the two contracts in sync.
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
      console.warn(`[atlassian] revoke skipped (${context}): stored credential decrypted to empty`);
      return 'no_credential';
    }

    const { clientId, clientSecret } = await getAtlassianOAuthConfig();
    if (!clientId || !clientSecret) {
      console.warn(`[atlassian] revoke skipped (${context}): OAuth client is not configured`);
      return 'not_configured';
    }

    const response = await fetch(ATLASSIAN_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, token }),
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[atlassian] revoke failed (${context}): ${response.status} ${await response.text()}`);
      return 'failed';
    }

    console.log(`[atlassian] revoked token at Atlassian (${context})`);
    return 'revoked';
  } catch (e) {
    console.error(`[atlassian] revoke failed (${context}) - the token may still be live at Atlassian`, e);
    return 'failed';
  }
}

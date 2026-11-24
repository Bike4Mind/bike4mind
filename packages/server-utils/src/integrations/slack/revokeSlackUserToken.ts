import { WebClient } from '@slack/web-api';
import { Logger } from '@bike4mind/observability';
import { decryptToken } from '../../security/tokenEncryption';

const REVOKE_TIMEOUT_MS = 10_000;

export type SlackRevokeOutcome = 'revoked' | 'no_credential' | 'failed';

/**
 * Revoke a stored (encrypted) Slack user token with `auth.revoke`, BEST EFFORT. Never throws, same
 * contract as revokeAtlassianGrant (../jira/revokeAtlassianGrant.ts). The token authorizes its own
 * revocation, so no app credentials are needed. Workspace bot tokens belong to the workspace install
 * and are not touched.
 */
export async function revokeSlackUserToken(
  encryptedToken: string | null | undefined,
  context: string
): Promise<SlackRevokeOutcome> {
  if (!encryptedToken) return 'no_credential';

  try {
    const token = decryptToken(encryptedToken);
    if (!token) {
      Logger.warn('[slack] revoke skipped: stored credential decrypted to empty', { context });
      return 'no_credential';
    }

    const client = new WebClient(token, { timeout: REVOKE_TIMEOUT_MS, retryConfig: { retries: 0 } });
    const result = await client.auth.revoke();
    if (!result.ok) {
      Logger.warn('[slack] revoke failed', { context, error: result.error });
      return 'failed';
    }
    Logger.info('[slack] revoked user token at Slack', { context });
    return 'revoked';
  } catch (e) {
    // An already revoked token answers `token_revoked` / `invalid_auth`, which the client throws.
    const code = (e as { data?: { error?: string } }).data?.error;
    Logger.warn('[slack] revoke failed - the token may still be live at Slack', { context, code });
    return 'failed';
  }
}

import type { IMcpConnectionDocument } from '@bike4mind/common';
import { RemoteMcpOAuthError, revokeRemoteMcpToken } from '@bike4mind/mcp/remote';
import { decryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { RemoteMcpNetworkOptions } from '../customMcpAccess';
import { loadConnectionClient } from './clientIdentity';
import { withOAuthFetch } from './oauthFetch';
import { redirectUri } from './redirectUri';

/**
 * RFC 7009 revocation of a connection's grant: the refresh token first, then the access token, at the
 * advertised endpoint. Best effort: a failure is logged by hint and code only (never a token value) and
 * never blocks the disconnect or delete that called it. Pass a connection read with credentials.
 */
export async function revokeConnectionGrant(
  connection: IMcpConnectionDocument,
  network: RemoteMcpNetworkOptions,
  fetchFn?: FetchLike
): Promise<void> {
  const oauth = connection.auth.oauth;
  if (connection.auth.kind !== 'oauth' || !oauth?.revocationEndpoint) return;
  const endpoint = oauth.revocationEndpoint;
  const tokens = [
    { hint: 'refresh_token' as const, token: decryptToken(oauth.refreshTokenEnc) },
    { hint: 'access_token' as const, token: decryptToken(oauth.accessTokenEnc) },
  ].filter((entry): entry is { hint: 'refresh_token' | 'access_token'; token: string } => Boolean(entry.token));
  if (tokens.length === 0) return;

  try {
    const client = await loadConnectionClient(connection, redirectUri());
    if (!client) return;
    await withOAuthFetch(network, fetchFn, async pinned => {
      for (const { hint, token } of tokens) {
        try {
          await revokeRemoteMcpToken(endpoint, { token, hint, client, fetchFn: pinned });
        } catch (error) {
          const code = error instanceof RemoteMcpOAuthError ? error.code : 'request_failed';
          console.warn(`[mcpOAuth] Revoking the ${hint} of connection ${connection.id} failed (${code})`);
        }
      }
    });
  } catch {
    console.warn(`[mcpOAuth] Could not revoke the grant of connection ${connection.id}`);
  }
}

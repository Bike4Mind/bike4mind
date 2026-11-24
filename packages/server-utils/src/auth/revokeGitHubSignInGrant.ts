import { Octokit } from '@octokit/rest';
import { AuthStrategy, type IAuthProviders } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { decryptAtRest } from '@bike4mind/utils/security';
import { Config } from '../utils/config';

const REVOKE_TIMEOUT_MS = 10_000;
const UNSET_SECRET = 'not-configured';

export type GitHubSignInRevokeOutcome = 'revoked' | 'no_token' | 'not_configured' | 'failed';

/**
 * Deletes the user's authorization of the GitHub sign-in OAuth app (`DELETE /applications/{client_id}/grant`),
 * which ends every token it issued to them. BEST EFFORT: never throws. Takes the providers read before
 * the user row was deleted; tokens are decrypted as sealProviderTokens wrote them.
 */
export async function revokeGitHubSignInGrant(
  authProviders: readonly IAuthProviders[] | null | undefined,
  context: string
): Promise<GitHubSignInRevokeOutcome> {
  const provider = authProviders?.find(p => p.strategy === AuthStrategy.Github);
  if (!provider?.accessToken) return 'no_token';

  const clientId = Config.GITHUB_CLIENT_ID;
  const clientSecret = Config.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret || clientId === UNSET_SECRET || clientSecret === UNSET_SECRET) {
    Logger.warn('[github] sign-in grant revoke skipped: OAuth app is not configured', { context });
    return 'not_configured';
  }

  try {
    const token = provider.encrypted ? decryptAtRest(provider.accessToken) : provider.accessToken;
    if (!token) {
      Logger.warn('[github] sign-in grant revoke skipped: stored token decrypted to empty', { context });
      return 'no_token';
    }
    await new Octokit({ request: { timeout: REVOKE_TIMEOUT_MS } }).request('DELETE /applications/{client_id}/grant', {
      client_id: clientId,
      access_token: token,
      headers: { authorization: `basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
    });
    Logger.info('[github] revoked the sign-in grant at GitHub', { context });
    return 'revoked';
  } catch (e) {
    const status = typeof e === 'object' && e !== null ? (e as { status?: unknown }).status : undefined;
    Logger.warn('[github] sign-in grant revoke failed - the grant may still be live at GitHub', { context, status });
    return 'failed';
  }
}

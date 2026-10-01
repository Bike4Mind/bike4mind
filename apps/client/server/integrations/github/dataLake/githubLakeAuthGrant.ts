import { gitHubLakeAuthGrantRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { decryptToken, encryptToken } from '@server/security/tokenEncryption';
import { ForbiddenError, InternalServerError } from '@server/utils/errors';
import { serializeError } from '@server/utils/serializeError';
import { revokeInstallerToken, type GitHubLakeAppConfig } from './lakeAppClient';

/**
 * The server-side half of the authorize-first lake connect: the user-to-server token minted by the
 * authorize callback, held until the repository pick completes the connect. Bound to the flow's
 * browser nonce (its hash is the key) and to the user + lake signed into its state, and short-lived
 * because it can list every repository its user can see through the App.
 */
export const GITHUB_LAKE_AUTH_GRANT_TTL_MS = 10 * 60 * 1000;

// 403, never 401: the client answers a 401 with a session refresh and, failing that, a sign-out.
const GRANT_EXPIRED_MESSAGE = 'Your GitHub authorization expired. Connect GitHub again.';

/** The flow's nonce hash (readStateNonceHash), or a 403 when this browser's nonce cookie is gone. */
export function requireGitHubLakeFlowNonce(nonceHash: string | null): string {
  if (!nonceHash) {
    throw new ForbiddenError(GRANT_EXPIRED_MESSAGE);
  }
  return nonceHash;
}

export async function storeGitHubLakeAuthGrant(
  config: GitHubLakeAppConfig,
  grant: { nonceHash: string; userId: string; dataLakeId: string; userToken: string }
): Promise<void> {
  const { userToken, ...binding } = grant;
  const encryptedToken = encryptToken(userToken);
  if (!encryptedToken) {
    throw new InternalServerError('Could not secure the GitHub authorization');
  }
  const replaced = await gitHubLakeAuthGrantRepository.replace({
    ...binding,
    encryptedToken,
    expiresAt: new Date(Date.now() + GITHUB_LAKE_AUTH_GRANT_TTL_MS),
  });
  // A second authorize in the same flow (the install fallback's return) supersedes the first token.
  if (replaced) await revokeGrantToken(config, replaced.encryptedToken);
}

/** The flow's user token, or a 403 when this browser holds no live grant for this user and lake. */
export async function readGitHubLakeUserToken(
  nonceHash: string,
  user: { id: string },
  dataLakeId: string
): Promise<string> {
  const grant = await gitHubLakeAuthGrantRepository.findLive(nonceHash);
  if (!grant || grant.userId !== user.id || grant.dataLakeId !== dataLakeId) {
    throw new ForbiddenError(GRANT_EXPIRED_MESSAGE);
  }
  const token = decryptToken(grant.encryptedToken);
  if (!token) {
    throw new ForbiddenError(GRANT_EXPIRED_MESSAGE);
  }
  return token;
}

/** Deletes the flow's grant and revokes its token; a no-op when another request already took it. */
export async function consumeGitHubLakeAuthGrant(config: GitHubLakeAppConfig, nonceHash: string): Promise<void> {
  const grant = await gitHubLakeAuthGrantRepository.consume(nonceHash);
  if (grant) await revokeGrantToken(config, grant.encryptedToken);
}

async function revokeGrantToken(config: GitHubLakeAppConfig, encryptedToken: string): Promise<void> {
  try {
    const token = decryptToken(encryptedToken);
    if (token) await revokeInstallerToken(config, token);
  } catch (error) {
    // Not fatal: nothing holds the token any more, and GitHub expires it on its own (8h).
    Logger.warn('GitHub lake connect: could not revoke a user token', { error: serializeError(error) });
  }
}

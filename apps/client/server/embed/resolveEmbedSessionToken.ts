import { verifyEmbedKeyById, type ApiKeyInfo } from '@server/cli/auth';
import { verifyEmbedSessionToken, type EmbedSessionContext } from './embedSessionToken';

/**
 * Verify a minted embed session token and re-load the live key behind it, so a token
 * cannot outlive a revoked/disabled key within its TTL. Shared by every surface that
 * accepts the token (the chat route and /api/embed/history) so the rule cannot drift.
 * @throws Error on any invalid token or key (callers map it to 401).
 */
export async function resolveEmbedSessionToken(
  bearer: string
): Promise<{ claims: EmbedSessionContext; info: ApiKeyInfo }> {
  const claims = verifyEmbedSessionToken(bearer);
  const info = await verifyEmbedKeyById(claims.keyId);
  if (info.agentId !== claims.agentId || info.organizationId !== claims.organizationId) {
    throw new Error('Session token does not match the embed key');
  }
  return { claims, info };
}

/** The bearer credential from an Authorization header, if any. */
export function extractBearer(authorization: string | undefined): string | undefined {
  return authorization && /^bearer /i.test(authorization) ? authorization.slice(7).trim() : undefined;
}

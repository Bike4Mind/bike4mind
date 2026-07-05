import { Connection } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { checkApiKeyRateLimitOrThrow, checkRateLimit, verifyBridgeApiKey, verifyJwtToken } from '@server/cli/auth';

export interface ResolvedBridgeAuth {
  userId: string;
  /** The API key the bridge authenticated with, or null for JWT fallback.
   *  Handlers that need to enforce revocation of the specific key (vs just
   *  the user) can resolve the paired device via this id. */
  apiKeyId: string | null;
}

/**
 * Resolve and authorize a cc-agent WS message.
 *
 * Returns `null` when auth fails or the body-token identity doesn't match
 * the identity that authenticated at `$connect` time. The caller is
 * expected to stop processing and return a non-2xx status back to the
 * client so the bridge can surface the failure.
 *
 * Three layered checks:
 *   1. `accessToken` in the body is a valid bridge-scoped API key or JWT.
 *   2. Rate-limits for that identity pass.
 *   3. The userId resolved from the token matches the userId the
 *      `Connection` row was bound to. This blocks cross-user spoofing:
 *      even if an attacker holds a valid API key for user B, they cannot
 *      use user A's open WS connection to impersonate B.
 */
export async function resolveBridgeWsAuth(params: {
  accessToken: string;
  connectionId: string;
  endpoint: string;
  logger: Logger;
  handlerName: string;
}): Promise<ResolvedBridgeAuth | null> {
  const { accessToken, connectionId, endpoint, logger, handlerName } = params;

  let userId: string | null = null;
  let apiKeyId: string | null = null;

  try {
    const apiKeyInfo = await verifyBridgeApiKey({ authorization: `Bearer ${accessToken}` });
    await checkApiKeyRateLimitOrThrow(apiKeyInfo, {
      userId: apiKeyInfo.userId,
      endpoint,
      method: 'WS',
    });
    userId = apiKeyInfo.userId;
    apiKeyId = apiKeyInfo.keyId;
  } catch (apiKeyErr) {
    try {
      const user = await verifyJwtToken(accessToken);
      await checkRateLimit(user.id);
      userId = user.id;
      // A bridge action authenticated by a JWT is unusual in steady state -
      // the daemon authenticates with an API key. Log so an unexpected fall-
      // through is visible in routine audits.
      logger.warn(`[${handlerName}] bridge action authenticated via JWT fallback`, { userId });
    } catch (jwtErr) {
      logger.warn(`[${handlerName}] auth failed`, {
        apiKeyError: apiKeyErr instanceof Error ? apiKeyErr.message : String(apiKeyErr),
        jwtError: jwtErr instanceof Error ? jwtErr.message : String(jwtErr),
      });
      return null;
    }
  }

  // Connection-binding check: the `$connect` handler already authenticated
  // this socket and wrote the userId into the `Connection` row. Require the
  // message-body token's userId to match, so a user who happens to hold two
  // API keys can't use key A's open connection to send events attributed
  // to key B's user. Normalize both sides through String() since the stored
  // userId may be either a raw ObjectId or its string form depending on
  // whether the lookup went through .lean().
  const connection = await Connection.findOne({ connectionId }).lean();
  const connUserId = connection?.userId != null ? String(connection.userId) : null;
  const bodyUserId = userId != null ? String(userId) : null;
  if (!connUserId || !bodyUserId || connUserId !== bodyUserId) {
    logger.warn(
      `[${handlerName}] connection/body userId mismatch (conn=${connUserId ?? 'none'}, body=${bodyUserId ?? 'none'})`
    );
    return null;
  }

  return { userId: bodyUserId, apiKeyId };
}

import { Connection, User, wsConnectTicketRepository } from '@bike4mind/database';
import { ApiKeyScope, ApiKeyScopeValue } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { assertAccountStateUsable } from '@bike4mind/server-utils/auth/assertAccountStateUsable';
import { isTokenTypeAcceptable, isTokenVersionCurrent } from '@bike4mind/services';
import { verifyApiKey } from '@server/cli/auth';
import { isAuthInfraFailure } from '@server/auth/apiKeyAuthFailure';
import { ForbiddenError, UnauthorizedError } from '@bike4mind/server-utils/utils/errors';
import { ipBlockRefusal } from '@server/middlewares/checkBlockedIP';
import { withWebSocketContext } from '@server/websocket/utils';
import { gatewayCapExpiry, assertRealtimeSessionActive } from '@server/websocket/realtimeSession';
import { APIGatewayProxyEvent, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import type { ConnectionSource } from '@bike4mind/common';

/** What a Connection row records about the credential that opened it (see IConnection). */
interface ConnectionAuth {
  sid?: string;
  tokenVersion?: number;
  authExpiresAt: Date;
  apiKeyId?: string;
}

/**
 * Extract the auth token from the Sec-WebSocket-Protocol header (CLI). The web
 * client authenticates with a single-use `?ticket=` (see resolveWebTicket), so a
 * long-lived session JWT never travels in the URL, where proxy/CDN/gateway access
 * logs, browser history, or a Referer header could leak it (RFC 6750 5.3, RFC 9700
 * 4.3.2).
 *
 * CLI sends: `new WebSocket(url, ['access_token.<jwt>'])`.
 * Returns both the token and the source of the connection.
 */
function extractToken(event: APIGatewayProxyWebsocketEventV2 & APIGatewayProxyEvent): {
  token: string;
  source: ConnectionSource;
} {
  // Sec-WebSocket-Protocol header - used by CLI
  const protocols = event.headers?.['sec-websocket-protocol'] || event.headers?.['Sec-WebSocket-Protocol'];
  if (protocols) {
    const tokenProtocol = protocols
      .split(',')
      .map(p => p.trim())
      .find(p => p.startsWith('access_token.'));
    if (tokenProtocol) return { token: tokenProtocol.slice('access_token.'.length), source: 'cli' };
  }

  throw new UnauthorizedError('No authentication token provided');
}

/**
 * Web `$connect` identity via a single-use `?ticket=<t>`. Atomically burns the
 * ticket (rejecting replay/expiry) and resolves the minting session's userId +
 * tokenVersion so the caller re-runs the same tokenVersion kill-switch the JWT
 * path enforces. Returns null when no ticket query param is present so the
 * caller can fall through to the CLI header path.
 */
async function resolveWebTicket(
  event: APIGatewayProxyWebsocketEventV2 & APIGatewayProxyEvent
): Promise<({ userId: string; tokenVersion: number; source: ConnectionSource } & ConnectionAuth) | null> {
  const queryTicket = event?.queryStringParameters?.ticket;
  if (!queryTicket) return null;

  const consumed = await wsConnectTicketRepository.consume(z.string().parse(queryTicket));
  if (!consumed) throw new UnauthorizedError('Invalid or expired connect ticket');

  return {
    userId: consumed.userId,
    tokenVersion: consumed.tokenVersion,
    source: 'web',
    sid: consumed.sid,
    // Tickets minted before authExpiresAt existed fall back to the gateway cap.
    authExpiresAt: consumed.authExpiresAt ?? gatewayCapExpiry(),
  };
}

/**
 * Resolve the token to a userId + (optional) scope list. JWT tokens have
 * no scopes - they're full-user sessions. API keys carry a scope array that
 * is persisted on the Connection row so any action handler that reads
 * `connection.userId` can also gate on `connection.scopes` as a cheap
 * defense-in-depth layer. Per-message `verifyApiKey` remains the primary
 * scope gate.
 *
 * Both JWT and API-key errors are logged so that a broken pairing or
 * rotated JWT secret surfaces in the connect logs instead of vanishing
 * behind a generic "invalid token" rejection.
 */
async function resolveIdentity(
  token: string,
  logger: Logger
): Promise<{ userId: string; scopes?: ApiKeyScopeValue[] } & ConnectionAuth> {
  let jwtErr: unknown;
  try {
    const decoded = authTokenGenerator.verifyToken(token) as jwt.JwtPayload;
    // Reject a token minted for a different path (e.g. a refresh token opening a socket).
    // Missing typ = legacy pre-claim token, accepted (self-expiring grace). Thrown rather
    // than returned so the API-key fallback below still gets its chance.
    if (!isTokenTypeAcceptable(decoded?.typ, 'access')) {
      throw new UnauthorizedError('Invalid token type');
    }
    // Reject a relying-party OAuth access token: it is signed with the same secret and
    // stamped typ:'access', so only this kind claim confines it to the OAuth REST scope.
    // MUST stay in sync with verifyWsAccessToken.ts and cli/auth.ts. Thrown, not returned,
    // so the API-key fallback below still runs.
    if ((decoded as { kind?: string })?.kind === 'oauth') {
      throw new UnauthorizedError('OAuth access tokens are not accepted on the realtime socket');
    }
    if (decoded?.mfaPending) {
      throw new UnauthorizedError('MFA verification required');
    }
    if (decoded?.impersonatedBy) {
      throw new UnauthorizedError('Impersonated sessions cannot use realtime credentials');
    }
    // JWT connections are always version-gated. A legacy token issued before
    // this field existed carries no version and normalizes to 0, mirroring the
    // REST path (auth.ts) so the kill switch still fires for it once the user's
    // version is bumped. The API-key path below leaves tokenVersion undefined
    // so the check is skipped only for API keys.
    if (decoded?.id) {
      return {
        userId: String(decoded.id),
        tokenVersion: decoded.tokenVersion ?? 0,
        sid: typeof decoded.sid === 'string' ? decoded.sid : undefined,
        // The CLI never sends reauth_connection, so the token exp would cut a live socket every
        // access-token lifetime; it is bounded by the gateway cap and ends on revoke instead.
        authExpiresAt: gatewayCapExpiry(),
      };
    }
  } catch (err) {
    jwtErr = err;
  }

  try {
    // Accept any of: AI_CHAT / AI_GENERATE (web CLI, legacy bridge) or
    // CC_BRIDGE (narrow bridge scope). The resolved scope list is persisted
    // below so action handlers can gate on it without re-verifying.
    const apiKeyInfo = await verifyApiKey(
      { authorization: `Bearer ${token}` },
      { requiredScopes: [ApiKeyScope.AI_GENERATE, ApiKeyScope.AI_CHAT, ApiKeyScope.CC_BRIDGE] }
    );
    return {
      userId: apiKeyInfo.userId,
      scopes: apiKeyInfo.scopes,
      apiKeyId: apiKeyInfo.keyId,
      authExpiresAt: gatewayCapExpiry(),
    };
  } catch (apiKeyErr) {
    // The key check itself failed (database unreachable): a retryable 5xx, not a bad token.
    if (isAuthInfraFailure(apiKeyErr)) throw apiKeyErr;
    logger.warn('[WS_CONNECT] both JWT and API-key auth failed', {
      jwtError: jwtErr instanceof Error ? jwtErr.message : String(jwtErr ?? 'n/a'),
      apiKeyError: apiKeyErr instanceof Error ? apiKeyErr.message : String(apiKeyErr),
    });
    throw new UnauthorizedError('Invalid authentication token');
  }
}

export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2 & APIGatewayProxyEvent>(
  async (event, context, logger) => {
    // Web path: a single-use ticket keeps the JWT out of the URL.
    // Falls through to the CLI header path when no ticket is present.
    const ticketIdentity = await resolveWebTicket(event);
    let userId: string;
    let source: ConnectionSource;
    let scopes: ApiKeyScopeValue[] | undefined = undefined;
    let auth: ConnectionAuth;
    if (ticketIdentity) {
      const { userId: ticketUserId, source: ticketSource, ...ticketAuth } = ticketIdentity;
      userId = ticketUserId;
      source = ticketSource;
      auth = ticketAuth;
    } else {
      const extracted = extractToken(event);
      source = extracted.source;
      const { userId: tokenUserId, scopes: tokenScopes, ...tokenAuth } = await resolveIdentity(extracted.token, logger);
      userId = tokenUserId;
      scopes = tokenScopes;
      auth = tokenAuth;
    }
    const { tokenVersion } = auth;

    const user = await User.findById(userId);
    if (!user) throw new UnauthorizedError('User not found');
    // Server-side kill switch (JWT connections only): reject a stale tokenVersion.
    // API-key connections resolve tokenVersion as undefined and are not gated here;
    // JWT connections always carry a number (legacy tokens normalize to 0).
    if (tokenVersion !== undefined && !isTokenVersionCurrent(tokenVersion, user.tokenVersion)) {
      throw new UnauthorizedError('Session expired');
    }
    assertAccountStateUsable(user);
    await assertRealtimeSessionActive(auth.sid);
    // Completions and agent runs stream over this socket, so an admin's `all` IP block refuses the connection.
    if (!user.isAdmin) {
      const clientRequest = {
        headers: event.headers,
        socket: { remoteAddress: event.requestContext.identity?.sourceIp },
      };
      const refusal = await ipBlockRefusal(clientRequest, 'app', logger);
      if (refusal) throw new ForbiddenError(refusal.message);
    }

    await Connection.create({
      connectionId: event.requestContext.connectionId,
      userId: user.id,
      source,
      ...(scopes !== undefined && { scopes }),
      ...(auth.sid && { sid: auth.sid }),
      ...(tokenVersion !== undefined && { tokenVersion }),
      authExpiresAt: auth.authExpiresAt,
      ...(auth.apiKeyId && { apiKeyId: auth.apiKeyId }),
    });

    user.lastActiveAt = new Date();
    user.isOnline = true;
    await user.save();

    return {
      statusCode: 200,
    };
  }
);

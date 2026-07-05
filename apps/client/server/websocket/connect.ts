import { Connection, User } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { isTokenVersionCurrent } from '@bike4mind/services';
import { verifyApiKey } from '@server/cli/auth';
import { UnauthorizedError } from '@server/utils/errors';
import { withWebSocketContext } from '@server/websocket/utils';
import { APIGatewayProxyEvent, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import type { ConnectionSource } from '@bike4mind/common';

/**
 * Extract auth token from either query params (web client) or
 * Sec-WebSocket-Protocol header (CLI - avoids token in URL/proxy logs).
 *
 * CLI sends: `new WebSocket(url, ['access_token.<jwt>'])`
 * Web client sends: `?token=<jwt>` query param
 *
 * Returns both the token and the source of the connection.
 */
function extractToken(event: APIGatewayProxyWebsocketEventV2 & APIGatewayProxyEvent): {
  token: string;
  source: ConnectionSource;
} {
  // 1. Query param - used by web client
  const queryToken = event?.queryStringParameters?.token;
  if (queryToken) return { token: z.string().parse(queryToken), source: 'web' };

  // 2. Sec-WebSocket-Protocol header - used by CLI
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
): Promise<{ userId: string; scopes?: ApiKeyScope[]; tokenVersion?: number }> {
  let jwtErr: unknown;
  try {
    const decoded = authTokenGenerator.verifyToken(token) as jwt.JwtPayload;
    // JWT connections are always version-gated. A legacy token issued before
    // this field existed carries no version and normalizes to 0, mirroring the
    // REST path (auth.ts) so the kill switch still fires for it once the user's
    // version is bumped. The API-key path below leaves tokenVersion undefined
    // so the check is skipped only for API keys.
    if (decoded?.id) return { userId: String(decoded.id), tokenVersion: decoded.tokenVersion ?? 0 };
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
    return { userId: apiKeyInfo.userId, scopes: apiKeyInfo.scopes };
  } catch (apiKeyErr) {
    logger.warn('[WS_CONNECT] both JWT and API-key auth failed', {
      jwtError: jwtErr instanceof Error ? jwtErr.message : String(jwtErr ?? 'n/a'),
      apiKeyError: apiKeyErr instanceof Error ? apiKeyErr.message : String(apiKeyErr),
    });
    throw new UnauthorizedError('Invalid authentication token');
  }
}

export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2 & APIGatewayProxyEvent>(
  async (event, context, logger) => {
    const { token, source } = extractToken(event);
    const { userId, scopes, tokenVersion } = await resolveIdentity(token, logger);

    const user = await User.findById(userId);
    if (!user) throw new UnauthorizedError('User not found');
    // Server-side kill switch (JWT connections only): reject a stale tokenVersion.
    // API-key connections resolve tokenVersion as undefined and are not gated here;
    // JWT connections always carry a number (legacy tokens normalize to 0).
    if (tokenVersion !== undefined && !isTokenVersionCurrent(tokenVersion, user.tokenVersion)) {
      throw new UnauthorizedError('Session expired');
    }

    await Connection.create({
      connectionId: event.requestContext.connectionId,
      userId: user.id,
      source,
      ...(scopes !== undefined && { scopes }),
    });

    user.lastActiveAt = new Date();
    user.isOnline = true;
    await user.save();

    return {
      statusCode: 200,
    };
  }
);

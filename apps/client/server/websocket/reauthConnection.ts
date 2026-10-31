import { GoneException } from '@aws-sdk/client-apigatewaymanagementapi';
import { ForbiddenError, NotFoundError, ReauthConnectionAction, UnauthorizedError } from '@bike4mind/common';
import { Connection, realtimeConnectionRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { closeConnection } from '@bike4mind/server-utils/websocket/closeConnection';
import { assertRealtimeSessionActive } from '@server/websocket/realtimeSession';
import { sendToConnection, withWebSocketContext } from '@bike4mind/server-utils/websocket/utils';
import { verifyWsAccessTokenClaims } from '@server/websocket/verifyWsAccessToken';
import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { JsonWebTokenError } from 'jsonwebtoken';
import { Resource } from 'sst';

class ReauthRefused extends Error {}

/** A genuine "this credential is not acceptable" outcome, as opposed to a lookup that failed. */
const isAuthRefusal = (error: unknown): error is Error =>
  error instanceof UnauthorizedError ||
  error instanceof ForbiddenError ||
  error instanceof NotFoundError ||
  error instanceof JsonWebTokenError;

/**
 * Resolve the new auth for this connection, or throw ReauthRefused. The token must belong to the
 * user that opened the socket and, when the socket was opened by a session, to that same session:
 * reauth extends a connection, it never moves one to another credential. Only genuine auth
 * refusals become ReauthRefused; a failed lookup (database, secret fetch) propagates and leaves the
 * connection as it was, since nothing has been changed yet.
 */
async function resolveReauth(connectionId: string, accessToken: string) {
  const connection = await Connection.findOne({ connectionId }).lean();
  if (!connection) throw new ReauthRefused('connection not found');
  if (connection.apiKeyId) throw new ReauthRefused('API-key connections cannot reauth');

  let claims: Awaited<ReturnType<typeof verifyWsAccessTokenClaims>>;
  try {
    claims = await verifyWsAccessTokenClaims(accessToken);
    await assertRealtimeSessionActive(claims.sid);
  } catch (error) {
    if (!isAuthRefusal(error)) throw error;
    throw new ReauthRefused(error.message);
  }
  if (claims.user.id !== connection.userId) throw new ReauthRefused('user mismatch');
  if (connection.sid && claims.sid !== connection.sid) throw new ReauthRefused('session mismatch');
  if (!claims.expiresAt) throw new ReauthRefused('token has no expiry');

  return {
    tokenVersion: claims.tokenVersion,
    authExpiresAt: claims.expiresAt,
    // A connection opened before sids were recorded binds to the session that first reauths it.
    ...(!connection.sid && claims.sid && { sid: claims.sid }),
  };
}

/**
 * End a connection the server can no longer vouch for: DB state first (always), then the socket.
 * The ended row is deleted once the close succeeded; if it did not, the realtime sweep retries.
 */
async function endRefusedConnection(connectionId: string, endpoint: string, logger: Logger): Promise<void> {
  await realtimeConnectionRepository.endConnections({ connectionIds: [connectionId] });
  try {
    await closeConnection(connectionId, endpoint);
    await realtimeConnectionRepository.deleteEndedConnections([connectionId]);
  } catch (error) {
    logger.warn(`[REAUTH] Failed to close connection ${connectionId}`, error as Error);
  }
}

/**
 * `reauth_connection`: the client sends its refreshed access token over the open socket. On
 * success the connection's tokenVersion and authExpiresAt move forward, every query subscription
 * it holds is dropped, and the client is told to re-subscribe, so each subscription's frozen ACL
 * scope is rebuilt under the new token. On refusal the connection is ended and the client
 * reconnects with a fresh ticket.
 */
export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async (event, context, logger) => {
  const endpoint = Resource.websocket.managementEndpoint;
  const connectionId = event.requestContext.connectionId;
  const { accessToken } = ReauthConnectionAction.parse(JSON.parse(event.body ?? ''));

  let auth: Awaited<ReturnType<typeof resolveReauth>>;
  try {
    auth = await resolveReauth(connectionId, accessToken);
  } catch (error) {
    if (!(error instanceof ReauthRefused)) throw error;
    logger.info(`[REAUTH] Refused for connection ${connectionId}: ${error.message}`);
    await endRefusedConnection(connectionId, endpoint, logger);
    return { statusCode: 401 };
  }

  const updated = await realtimeConnectionRepository.reauthenticate(connectionId, auth);
  if (!updated) {
    await endRefusedConnection(connectionId, endpoint, logger);
    return { statusCode: 401 };
  }

  try {
    await sendToConnection(connectionId, endpoint, { action: 'resubscribe_required' });
  } catch (error) {
    // The subscriptions are already pulled, so a client that never hears this would sit on a
    // silent socket. A gone socket needs nothing ($disconnect cleans up); any other failure ends
    // the connection so the client reconnects and subscribes afresh.
    if (error instanceof GoneException) return { statusCode: 200 };
    logger.warn(`[REAUTH] Failed to send resubscribe_required to ${connectionId}`, error as Error);
    await endRefusedConnection(connectionId, endpoint, logger);
    return { statusCode: 500 };
  }
  return { statusCode: 200 };
});

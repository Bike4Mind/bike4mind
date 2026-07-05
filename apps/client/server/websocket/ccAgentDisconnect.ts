import { activeCodeAgentRepository, ccBridgeDeviceRepository } from '@bike4mind/database';
import { CcAgentDisconnectAction } from '@bike4mind/common';
import { resolveBridgeWsAuth } from '@server/websocket/ccAgentAuth';
import { connectionUserCanAccessTavern } from '@server/websocket/tavernWsAuth';
import { sendToClient, withWebSocketContext } from '@server/websocket/utils';
import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';

/**
 * WebSocket handler: cc_agent_disconnect
 *
 * Bridge signals a clean session end (user hit /exit, tab closed, etc.).
 * We remove the `ActiveCodeAgent` record and broadcast a `remove_entity`
 * scene command so the sprite despawns in every open Tavern tab.
 *
 * The `$disconnect` handler performs the same cleanup as a safety net
 * for crashed bridges.
 */
export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async (event, _context, logger) => {
  const { connectionId, domainName, stage } = event.requestContext;
  const endpoint = `https://${domainName}/${stage}`;

  let body: ReturnType<typeof CcAgentDisconnectAction.parse>;
  try {
    body = CcAgentDisconnectAction.parse(JSON.parse(event.body ?? ''));
  } catch (parseError) {
    logger.error('[CC_AGENT_DISCONNECT] Failed to parse request body:', parseError);
    return { statusCode: 400 };
  }

  const { accessToken, instanceId, reason } = body;
  if (!accessToken) {
    logger.warn('[CC_AGENT_DISCONNECT] Missing accessToken in message body');
    return { statusCode: 401 };
  }

  const auth = await resolveBridgeWsAuth({
    accessToken,
    connectionId,
    endpoint: 'ws/cc_agent_disconnect',
    logger,
    handlerName: 'CC_AGENT_DISCONNECT',
  });
  if (!auth) return { statusCode: 401 };
  const { userId, apiKeyId } = auth;

  // Bridge is the sole caller of this action in steady state and always
  // authenticates with a device-scoped API key. A JWT fallback would skip
  // the device-binding check below and let any of the user's authenticated
  // contexts despawn another bridge's sprites. Fail closed.
  if (!apiKeyId) {
    logger.warn('[CC_AGENT_DISCONNECT] JWT-authenticated bridge action rejected; bridge must use device API key');
    return { statusCode: 401 };
  }

  // Tavern access gate: a valid bridge identity isn't enough - the owning user
  // must be allowed to reach the Tavern (admin or 'tavern' tag), the same
  // predicate the HTTP surface enforces via ensureTavernAccess.
  // Intentionally checked before the instance/device-ownership checks below:
  // run the cheap access predicate first so an unauthorized caller never reaches
  // the DB lookups/writes (defense-in-depth ordering).
  if (!(await connectionUserCanAccessTavern(userId))) {
    logger.warn(`[CC_AGENT_DISCONNECT] User ${userId} lacks Tavern access - dropping disconnect for ${instanceId}`);
    return { statusCode: 403 };
  }

  const existing = await activeCodeAgentRepository.findByInstanceId(instanceId);
  if (!existing || existing.userId !== userId) {
    logger.warn(`[CC_AGENT_DISCONNECT] Unknown or cross-user instance ${instanceId}; dropping disconnect`);
    return { statusCode: 404 };
  }

  // Device binding: require the caller's API key to be paired to the same
  // device that registered this instance. Prevents a revoked-but-still-open
  // bridge socket from despawning sprites owned by a valid sibling bridge.
  // String() both sides - `.lean()` returns `_id` as ObjectId while
  // `existing.deviceId` is stored as String.
  const device = await ccBridgeDeviceRepository.findByApiKeyId(apiKeyId);
  const keyDeviceId = device?._id != null ? String(device._id) : null;
  if (!device || device.revokedAt || keyDeviceId !== String(existing.deviceId)) {
    logger.warn(
      `[CC_AGENT_DISCONNECT] Device/key mismatch for instance ${instanceId} (keyDevice=${keyDeviceId ?? 'none'}, instanceDevice=${existing.deviceId})`
    );
    return { statusCode: 403 };
  }

  await activeCodeAgentRepository.removeByInstanceId(instanceId);

  logger.info(`[CC_AGENT_DISCONNECT] User ${userId} ended CC agent ${instanceId}${reason ? ` (${reason})` : ''}`);

  await sendToClient(
    userId,
    endpoint,
    {
      action: 'tavern_scene_broadcast' as const,
      commands: [{ type: 'remove_entity' as const, id: `cc_agent_${instanceId}` }],
    },
    { sourceFilter: 'web' }
  );

  return { statusCode: 200 };
});

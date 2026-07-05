import { activeCodeAgentRepository, ccBridgeDeviceRepository, codeAgentEventRepository } from '@bike4mind/database';
import { CcAgentEventAction } from '@bike4mind/common';
import { resolveBridgeWsAuth } from '@server/websocket/ccAgentAuth';
import { connectionUserCanAccessTavern } from '@server/websocket/tavernWsAuth';
import { sendToClient, withWebSocketContext } from '@server/websocket/utils';
import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';

/** Limit the hover-preview text we store to keep Mongo documents small. */
const MAX_SUMMARY_LEN = 280;

/** Truncate message text to bound the broadcast payload and Mongo doc size. */
function truncateText(text: string): string {
  return text.length > MAX_SUMMARY_LEN ? `${text.slice(0, MAX_SUMMARY_LEN - 1)}…` : text;
}

/**
 * WebSocket handler: cc_agent_event
 *
 * Bridge streams events for an already-registered session. We persist the
 * update in the `ActiveCodeAgent` record (keeps the TTL fresh) and emit a
 * scene-level `update_metadata` command so every open tavern tab refreshes
 * the sprite's status chip + lastSummary without a full re-register.
 */
export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async (event, _context, logger) => {
  const { connectionId, domainName, stage } = event.requestContext;
  const endpoint = `https://${domainName}/${stage}`;
  let body: ReturnType<typeof CcAgentEventAction.parse>;
  try {
    body = CcAgentEventAction.parse(JSON.parse(event.body ?? ''));
  } catch (parseError) {
    logger.error('[CC_AGENT_EVENT] Failed to parse request body:', parseError);
    return { statusCode: 400 };
  }

  const { accessToken, instanceId, event: payload } = body;
  if (!accessToken) {
    logger.warn('[CC_AGENT_EVENT] Missing accessToken in message body');
    return { statusCode: 401 };
  }

  const auth = await resolveBridgeWsAuth({
    accessToken,
    connectionId,
    endpoint: 'ws/cc_agent_event',
    logger,
    handlerName: 'CC_AGENT_EVENT',
  });
  if (!auth) return { statusCode: 401 };
  const { userId, apiKeyId } = auth;

  // Bridge is the sole caller of this action in steady state and always
  // authenticates with a device-scoped API key. A JWT fallback would skip
  // the device-binding check below - which is the only thing stopping one
  // of the user's other authenticated contexts (tab, CLI, old bridge) from
  // mutating sprites that belong to a specific paired device. Fail closed.
  if (!apiKeyId) {
    logger.warn('[CC_AGENT_EVENT] JWT-authenticated bridge action rejected; bridge must use device API key');
    return { statusCode: 401 };
  }

  // Tavern access gate: a valid bridge identity isn't enough - the owning user
  // must be allowed to reach the Tavern (admin or 'tavern' tag), the same
  // predicate the HTTP surface enforces via ensureTavernAccess.
  // Intentionally checked before the instance/device-ownership checks below:
  // run the cheap access predicate first so an unauthorized caller never reaches
  // the DB lookups/writes (defense-in-depth ordering).
  if (!(await connectionUserCanAccessTavern(userId))) {
    logger.warn(`[CC_AGENT_EVENT] User ${userId} lacks Tavern access - dropping event for ${instanceId}`);
    return { statusCode: 403 };
  }

  // Scope check: the event must be for an agent the authenticated user owns.
  const existing = await activeCodeAgentRepository.findByInstanceId(instanceId);
  if (!existing || existing.userId !== userId) {
    logger.warn(`[CC_AGENT_EVENT] Unknown or cross-user instance ${instanceId}; dropping event`);
    return { statusCode: 404 };
  }

  // Device binding: require the caller's API key's paired device to match
  // the one that registered this instance. Without this check a stale WS
  // socket authenticated by a revoked/other bridge key (same user) could
  // still mutate sprites owned by a valid bridge. String() both sides -
  // Mongoose `.lean()` returns `_id` as ObjectId while `existing.deviceId`
  // is stored as String.
  const device = await ccBridgeDeviceRepository.findByApiKeyId(apiKeyId);
  const keyDeviceId = device?._id != null ? String(device._id) : null;
  if (!device || device.revokedAt || keyDeviceId !== String(existing.deviceId)) {
    logger.warn(
      `[CC_AGENT_EVENT] Device/key mismatch for instance ${instanceId} (keyDevice=${keyDeviceId ?? 'none'}, instanceDevice=${existing.deviceId})`
    );
    return { statusCode: 403 };
  }

  const metadataPatch: Record<string, unknown> = {};

  // Sprite-metadata update varies by payload type. The `lastSummary`
  // hover preview should reflect the most recent thing the user cares
  // about - status transitions and user/assistant turns do that well;
  // tool traffic is too noisy and gets skipped on the summary path.
  if (payload.type === 'status') {
    const summary = payload.text !== undefined ? truncateText(payload.text) : undefined;
    await activeCodeAgentRepository.updateStatus(instanceId, payload.status, summary);
    metadataPatch.status = payload.status;
    if (summary !== undefined) metadataPatch.lastSummary = summary;
  } else if (payload.type === 'message') {
    const summary = truncateText(payload.text);
    await activeCodeAgentRepository.touch(instanceId, summary);
    metadataPatch.lastSummary = summary;
  } else {
    // tool_use / tool_result - just bump lastEventAt, keep the summary.
    await activeCodeAgentRepository.touch(instanceId);
  }

  // Persist the full event for the read-only transcript view. We store
  // un-truncated `text` up to the schema's 4000-char cap - the 280-char
  // `lastSummary` is strictly a UI hover preview.
  //
  // Non-fatal: a persistence miss shouldn't block the sprite update. The
  // scene stays live; the transcript for this one event is simply absent.
  try {
    const occurredAt = new Date(body.timestamp);
    const safeOccurredAt = isNaN(occurredAt.getTime()) ? new Date() : occurredAt;
    // `permission_request.input` maps onto the shared `text` column - the
    // modal renders it as the body of the permission prompt. Keeping a
    // single text field keeps persistence schema-agnostic.
    const text = payload.type === 'permission_request' ? payload.input : 'text' in payload ? payload.text : undefined;
    await codeAgentEventRepository.insert({
      userId,
      instanceId,
      type: payload.type,
      status: payload.type === 'status' ? payload.status : undefined,
      role: payload.type === 'message' ? payload.role : undefined,
      text,
      tool: payload.type === 'tool_use' || payload.type === 'tool_result' ? payload.tool : undefined,
      toolUseId: payload.type === 'tool_use' || payload.type === 'tool_result' ? payload.toolUseId : undefined,
      isError: payload.type === 'tool_result' ? payload.isError : undefined,
      requestId:
        payload.type === 'permission_request' || payload.type === 'permission_resolved' ? payload.requestId : undefined,
      toolName: payload.type === 'permission_request' ? payload.toolName : undefined,
      allow: payload.type === 'permission_resolved' ? payload.allow : undefined,
      resolvedBy: payload.type === 'permission_resolved' ? payload.resolvedBy : undefined,
      occurredAt: safeOccurredAt,
    });
  } catch (err) {
    logger.warn('[CC_AGENT_EVENT] Failed to persist transcript event (non-fatal):', err as Error);
  }

  // Expose the refresh time to the client so it can render "last active"
  // tooltips that stay honest even during quiet heartbeat-only stretches.
  metadataPatch.lastEventAt = new Date().toISOString();

  try {
    await sendToClient(
      userId,
      endpoint,
      {
        action: 'tavern_scene_broadcast' as const,
        commands: [
          {
            type: 'update_metadata' as const,
            id: `cc_agent_${instanceId}`,
            patch: metadataPatch,
          },
        ],
      },
      { sourceFilter: 'web' }
    );
  } catch (err) {
    logger.warn('[CC_AGENT_EVENT] Failed to broadcast metadata patch (non-fatal):', err as Error);
  }

  return { statusCode: 200 };
});

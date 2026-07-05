import { activeCodeAgentRepository, CcBridgeDevice, ccBridgeDeviceRepository } from '@bike4mind/database';
import { CcAgentRegisterAction, type ICcAgentCapability, type ICcAgentSource } from '@bike4mind/common';
import { resolveBridgeWsAuth } from '@server/websocket/ccAgentAuth';
import { connectionUserCanAccessTavern } from '@server/websocket/tavernWsAuth';
import { sendToClient, withWebSocketContext } from '@server/websocket/utils';
import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';

/** Sprite pool used for Claude Code agent entities. Reuses existing sprite
 *  sheets; later phases will add a distinguishing badge overlay in the
 *  renderer. Keep in sync with agentSpriteMapper.ts AGENT_SPRITES. */
const CC_AGENT_SPRITES = ['knight', 'think_guy', 'watcher', 'orc_player', 'drow_player', 'dwarf_player'];

/** Spawn "coder corner" - a small cluster near the tavern center. Tuned
 *  empirically; any unreachable tile is still safe because the client's
 *  wander scheduler (later phase) will path from here to a walkable tile.
 *  Per-session jitter uses the instanceId as the RNG seed so repeated
 *  reconnects of the same session land on the same tile (no visible
 *  jitter on reconnect), while multiple sessions spread out. */
const SPAWN_CENTER = { x: 52, y: 78 };
const SPAWN_JITTER = 3;

function pickSprite(seed: string): string {
  // `>>> 0` coerces to unsigned 32-bit so no Math.abs(-2^31) trap; the
  // unsigned mod is well-distributed across CC_AGENT_SPRITES for UUID-shaped
  // seeds like Claude Code session IDs.
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return CC_AGENT_SPRITES[hash % CC_AGENT_SPRITES.length];
}

function pickSpawnPosition(): { x: number; y: number } {
  return {
    x: SPAWN_CENTER.x + Math.floor((Math.random() - 0.5) * 2 * SPAWN_JITTER),
    y: SPAWN_CENTER.y + Math.floor((Math.random() - 0.5) * 2 * SPAWN_JITTER),
  };
}

/** Clamp startedAt to a sane window: older than 30d or far-future timestamps
 *  are almost certainly bridge-side clock skew or a malicious client trying
 *  to produce silly "started 974 years from now" tooltips. Fall back to the
 *  server clock in those cases. */
function coerceStartedAt(raw: string): Date {
  const parsed = new Date(raw);
  const now = Date.now();
  if (isNaN(parsed.getTime())) return new Date();
  const t = parsed.getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60_000;
  if (t < now - thirtyDaysMs || t > now + 60_000) return new Date();
  return parsed;
}

/**
 * Capabilities the server is willing to accept for each engine source.
 * `claude` is hooks-driven observer+: the bridge can only read the
 * transcript, so no interactive capability can ever be honored regardless
 * of what the announcer claims. `sdk-embedded` and `b4m-cli` are both
 * interactive by design. Anything not in this table is dropped.
 */
const ALLOWED_CAPABILITIES_BY_SOURCE: Record<ICcAgentSource, ReadonlySet<ICcAgentCapability>> = {
  claude: new Set<ICcAgentCapability>(),
  'sdk-embedded': new Set<ICcAgentCapability>(['interactive']),
  'b4m-cli': new Set<ICcAgentCapability>(['interactive']),
};

/**
 * Clamp the announcer's claimed source + capabilities against the
 * source-specific allowlist. Prevents a local process holding the bridge's
 * hookSecret from announcing an observer+ `claude` session with
 * `capabilities: ['interactive']` and thereby tricking
 * `POST /api/cc-bridge/command` into dispatching prompts to a read-only
 * engine (or worse, a spoofed record over a legitimate session).
 */
function normalizeSourceAndCapabilities(
  rawSource: ICcAgentSource | undefined,
  rawCapabilities: ICcAgentCapability[] | undefined
): { source: ICcAgentSource; capabilities: ICcAgentCapability[] } {
  const source: ICcAgentSource = rawSource ?? 'claude';
  const allowed = ALLOWED_CAPABILITIES_BY_SOURCE[source];
  const capabilities = (rawCapabilities ?? []).filter(c => allowed.has(c));
  return { source, capabilities };
}

/**
 * WebSocket handler: cc_agent_register
 *
 * Bridge announces a newly-started Claude Code session. We persist an
 * `ActiveCodeAgent` record, pick a sprite + spawn position, and broadcast
 * an `add_entity` scene command to every tab on the user's account so
 * the sprite appears in the Tavern live.
 */
export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async (event, _context, logger) => {
  const { connectionId, domainName, stage } = event.requestContext;
  const endpoint = `https://${domainName}/${stage}`;

  let body: ReturnType<typeof CcAgentRegisterAction.parse>;
  try {
    body = CcAgentRegisterAction.parse(JSON.parse(event.body ?? ''));
  } catch (parseError) {
    logger.error('[CC_AGENT_REGISTER] Failed to parse request body:', parseError);
    return { statusCode: 400 };
  }

  const {
    accessToken,
    instanceId,
    deviceId,
    workspaceName,
    workspacePath,
    claudeVersion,
    startedAt,
    source: rawSource,
    capabilities: rawCapabilities,
  } = body;
  if (!accessToken) {
    logger.warn('[CC_AGENT_REGISTER] Missing accessToken in message body');
    return { statusCode: 401 };
  }

  const { source, capabilities } = normalizeSourceAndCapabilities(rawSource, rawCapabilities);

  const auth = await resolveBridgeWsAuth({
    accessToken,
    connectionId,
    endpoint: 'ws/cc_agent_register',
    logger,
    handlerName: 'CC_AGENT_REGISTER',
  });
  if (!auth) return { statusCode: 401 };
  const { userId } = auth;

  // Tavern access gate: a valid bridge identity isn't enough - the owning user
  // must be allowed to reach the Tavern (admin or 'tavern' tag), the same
  // predicate the HTTP surface enforces via ensureTavernAccess.
  if (!(await connectionUserCanAccessTavern(userId))) {
    logger.warn(`[CC_AGENT_REGISTER] User ${userId} lacks Tavern access - rejecting register for ${instanceId}`);
    return { statusCode: 403 };
  }

  // Verify the claimed device belongs to the authenticated user and is not
  // revoked. Prevents a leaked API key from being used to spoof a different
  // user's device ID.
  const device = await CcBridgeDevice.findById(deviceId).lean();
  if (!device || device.userId !== userId || device.revokedAt) {
    logger.warn(
      `[CC_AGENT_REGISTER] Device ${deviceId} missing/wrong user/revoked — rejecting register for ${instanceId}`
    );
    return { statusCode: 403 };
  }

  const spriteId = pickSprite(instanceId);
  const position = pickSpawnPosition();

  const record = await activeCodeAgentRepository.upsertOnRegister({
    userId,
    deviceId,
    instanceId,
    connectionId,
    workspaceName,
    workspacePath,
    claudeVersion,
    source,
    capabilities,
    spriteId,
    position,
    startedAt: coerceStartedAt(startedAt),
  });

  await ccBridgeDeviceRepository.touch(deviceId);

  logger.info(
    `[CC_AGENT_REGISTER] User ${userId} registered CC agent ${instanceId} (${workspaceName}) on device ${deviceId}`
  );

  await sendToClient(
    userId,
    endpoint,
    {
      action: 'tavern_scene_broadcast' as const,
      commands: [
        {
          type: 'add_entity' as const,
          params: {
            id: `cc_agent_${instanceId}`,
            spriteSheetId: record.spriteId,
            position: record.position,
            animation: 'idle',
            visible: true,
            metadata: {
              kind: 'code_agent',
              instanceId,
              deviceId,
              workspaceName,
              workspacePath,
              status: record.status,
              source: record.source,
              capabilities: record.capabilities,
              startedAt: record.startedAt.toISOString(),
              lastEventAt: record.lastEventAt.toISOString(),
            },
          },
        },
      ],
    },
    // Only fan out to web tabs - the bridge that just sent this message
    // doesn't need to receive its own broadcast, and forwarding it wastes
    // a WS round-trip per event.
    { sourceFilter: 'web' }
  );

  return { statusCode: 200 };
});

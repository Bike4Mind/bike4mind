import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionSlug } from '@bike4mind/hearth';

/**
 * Contract for the cc-bridge -> Hearth dual-write across all four bridge write
 * points. Two things are load-bearing here and both are easy to regress:
 *
 *  1. CONTENT-FREE. Every mock below carries a unique bait string in a
 *     content-bearing field (message text, status summary, lastSummary, the full
 *     workspacePath, a caller-supplied disconnect reason). None may appear in an
 *     appended Hearth event - same discipline as the hook's privacy test.
 *  2. BEST EFFORT. The Tavern's ActiveCodeAgent writes and scene broadcasts must
 *     behave identically whether the Hearth write succeeds or explodes.
 */
const {
  activeCodeAgentRepositoryMock,
  ccBridgeDeviceRepositoryMock,
  ccBridgeDeviceModelMock,
  hearthRepositoryMock,
  sendToClientMock,
  resolveBridgeWsAuthMock,
  canAccessTavernMock,
  codeAgentEventRepositoryMock,
  connectionMock,
  querySubscriptionMock,
  userModelMock,
  userServiceMock,
} = vi.hoisted(() => ({
  activeCodeAgentRepositoryMock: {
    upsertOnRegister: vi.fn(),
    findByInstanceId: vi.fn(),
    updateStatus: vi.fn(),
    touch: vi.fn(),
    removeByInstanceId: vi.fn(),
    removeByConnectionId: vi.fn(),
  },
  ccBridgeDeviceRepositoryMock: { touch: vi.fn(), findByApiKeyId: vi.fn(), findById: vi.fn() },
  ccBridgeDeviceModelMock: { findById: vi.fn() },
  hearthRepositoryMock: {
    store: { appendEvent: vi.fn(), eventsSince: vi.fn(), getCursor: vi.fn(), setCursor: vi.fn() },
    ensureChannelByName: vi.fn(),
    getOwnedChannel: vi.fn(),
    ensureActor: vi.fn(),
    upsertPresence: vi.fn(),
  },
  sendToClientMock: vi.fn(),
  resolveBridgeWsAuthMock: vi.fn(),
  canAccessTavernMock: vi.fn(),
  codeAgentEventRepositoryMock: { insert: vi.fn() },
  connectionMock: { findOne: vi.fn(), deleteOne: vi.fn(), countDocuments: vi.fn() },
  querySubscriptionMock: { updateMany: vi.fn() },
  userModelMock: { updateOne: vi.fn() },
  userServiceMock: { updateLogoutTime: vi.fn() },
}));

vi.mock('@bike4mind/database', () => ({
  activeCodeAgentRepository: activeCodeAgentRepositoryMock,
  ccBridgeDeviceRepository: ccBridgeDeviceRepositoryMock,
  CcBridgeDevice: ccBridgeDeviceModelMock,
  codeAgentEventRepository: codeAgentEventRepositoryMock,
  hearthRepository: hearthRepositoryMock,
  Connection: connectionMock,
  QuerySubscription: querySubscriptionMock,
  User: userModelMock,
  userRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ userService: userServiceMock }));
vi.mock('@server/websocket/utils', () => ({
  withWebSocketContext: (handler: unknown) => handler,
  sendToClient: sendToClientMock,
}));
vi.mock('@server/websocket/ccAgentAuth', () => ({ resolveBridgeWsAuth: resolveBridgeWsAuthMock }));
vi.mock('@server/websocket/tavernWsAuth', () => ({ connectionUserCanAccessTavern: canAccessTavernMock }));

const USER = 'u1';
const INSTANCE = 'a67cd606-80f3-459d-88b5-3df6d3c11a31';
const DEVICE = 'dev-1';
const SLUG = sessionSlug(INSTANCE);
/** Append time of the stubbed event; the roster row must be stamped with it. */
const EVENT_CREATED_AT = new Date('2026-07-28T12:00:00Z');

/** Content-bearing values that must never reach the Hearth log. */
const BAIT = [
  'BAIT-workspace-path',
  'BAIT-status-summary',
  'BAIT-last-summary',
  'BAIT-message-text',
  'BAIT-disconnect-reason',
];

const ACTIVE_AGENT = {
  userId: USER,
  deviceId: DEVICE,
  instanceId: INSTANCE,
  workspaceName: 'bluebike4mind',
  workspacePath: '/Users/someone/BAIT-workspace-path/bluebike4mind',
  claudeVersion: '2.1.0',
  source: 'claude' as const,
  capabilities: [],
  status: 'running' as const,
  lastSummary: 'BAIT-last-summary',
  spriteId: 'knight',
  position: { x: 1, y: 2 },
  startedAt: new Date('2026-07-27T00:00:00Z'),
  lastEventAt: new Date('2026-07-27T00:00:00Z'),
};

const makeEvent = (body: unknown) => ({
  requestContext: { connectionId: 'conn-1', domainName: 'ws.example.com', stage: 'dev' },
  body: JSON.stringify(body),
});

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/**
 * Handlers are typed against APIGatewayProxyWebsocketEventV2/Context/Logger;
 * building those full AWS shapes per case would bury the assertions, so each
 * handler is loaded through a minimal structural signature instead.
 */
type LoadedHandler = (event: unknown, context: unknown, logger: unknown) => Promise<{ statusCode: number }>;

async function loadHandler(path: string): Promise<LoadedHandler> {
  const mod = (await import(path)) as { func: unknown };
  return mod.func as LoadedHandler;
}

/** The single append the dual-write is expected to have made. */
function appendedEvent() {
  expect(hearthRepositoryMock.store.appendEvent).toHaveBeenCalledTimes(1);
  return hearthRepositoryMock.store.appendEvent.mock.calls[0][0] as {
    channelId: string;
    actorId: string;
    kind: string;
    human: { text: string; format: string };
    machine: { schema: string; payload: Record<string, unknown> };
  };
}

/** The single roster upsert the dual-write is expected to have made. */
function upsertedPresence() {
  expect(hearthRepositoryMock.upsertPresence).toHaveBeenCalledTimes(1);
  return hearthRepositoryMock.upsertPresence.mock.calls[0][0] as {
    channelId: string;
    actorId: string;
    userId: string;
    lastSeen: Date;
    reason: string;
    workspace?: string;
    sessionId?: string;
    slug?: string;
  };
}

/** Neither the appended event nor the projected roster row may carry content. */
function expectNoBait() {
  const wire = JSON.stringify([
    hearthRepositoryMock.store.appendEvent.mock.calls,
    hearthRepositoryMock.upsertPresence.mock.calls,
  ]);
  for (const bait of BAIT) {
    expect(wire, `leaked ${bait}`).not.toContain(bait);
  }
}

/** Happy-path mock state. Re-appliable, so a case can clear and re-arm mid-test. */
function applyMockDefaults() {
  resolveBridgeWsAuthMock.mockResolvedValue({ userId: USER, apiKeyId: 'key-1' });
  canAccessTavernMock.mockResolvedValue(true);
  ccBridgeDeviceModelMock.findById.mockReturnValue({
    lean: () => Promise.resolve({ _id: DEVICE, userId: USER }),
  });
  ccBridgeDeviceRepositoryMock.findByApiKeyId.mockResolvedValue({ _id: DEVICE, userId: USER });
  ccBridgeDeviceRepositoryMock.findById.mockResolvedValue({ _id: DEVICE, userId: USER });
  activeCodeAgentRepositoryMock.upsertOnRegister.mockResolvedValue(ACTIVE_AGENT);
  activeCodeAgentRepositoryMock.findByInstanceId.mockResolvedValue(ACTIVE_AGENT);
  hearthRepositoryMock.ensureChannelByName.mockResolvedValue({ _id: 'ch-default' });
  hearthRepositoryMock.getOwnedChannel.mockResolvedValue({ _id: 'ch-override' });
  hearthRepositoryMock.ensureActor.mockResolvedValue({ _id: { toString: () => 'actor-1' } });
  hearthRepositoryMock.store.appendEvent.mockResolvedValue({
    id: 'ev-1',
    channelId: 'ch-default',
    seq: 1,
    actorId: 'actor-1',
    kind: 'presence',
    human: { text: 'x', format: 'text' },
    refs: {},
    createdAt: EVENT_CREATED_AT,
  });
  hearthRepositoryMock.upsertPresence.mockResolvedValue({ _id: 'presence-1' });
  connectionMock.findOne.mockResolvedValue({ connectionId: 'conn-1', userId: USER });
  connectionMock.deleteOne.mockResolvedValue({ deletedCount: 1 });
  connectionMock.countDocuments.mockResolvedValue(1);
  querySubscriptionMock.updateMany.mockResolvedValue({ modifiedCount: 0 });
  activeCodeAgentRepositoryMock.removeByConnectionId.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  applyMockDefaults();
});

const REGISTER_BODY = {
  action: 'cc_agent_register',
  accessToken: 'tok',
  instanceId: INSTANCE,
  deviceId: DEVICE,
  workspaceName: 'bluebike4mind',
  workspacePath: '/Users/someone/BAIT-workspace-path/bluebike4mind',
  claudeVersion: '2.1.0',
  startedAt: new Date().toISOString(),
};

describe('cc_agent_register dual-write', () => {
  it('appends a session_start presence event for a per-session agent actor', async () => {
    const func = await loadHandler('../ccAgentRegister');
    const res = await func(makeEvent(REGISTER_BODY), {}, makeLogger());

    expect(res.statusCode).toBe(200);
    const appended = appendedEvent();
    expect(appended.kind).toBe('presence');
    expect(appended.channelId).toBe('ch-default');
    expect(appended.actorId).toBe('actor-1');
    expect(hearthRepositoryMock.ensureChannelByName).toHaveBeenCalledWith(USER, 'agents');
    expect(hearthRepositoryMock.ensureActor).toHaveBeenCalledWith(USER, 'agent', `bluebike4mind (${SLUG})`);
    expect(appended.machine.schema).toBe('hearth.cc-bridge@1');
    expect(appended.machine.payload).toEqual({
      instanceId: INSTANCE,
      slug: SLUG,
      workspace: 'bluebike4mind',
      reason: 'session_start',
      source: 'claude',
      claudeVersion: '2.1.0',
    });
    expect(appended.human.text).toBe(`bluebike4mind (${SLUG}) started a session`);
    expectNoBait();
  });

  it('projects the session onto the roster row for the same channel and actor', async () => {
    const func = await loadHandler('../ccAgentRegister');
    await func(makeEvent(REGISTER_BODY), {}, makeLogger());

    expect(upsertedPresence()).toEqual({
      channelId: 'ch-default',
      actorId: 'actor-1',
      userId: USER,
      // The event's append time, not the write's, so a delayed report cannot
      // outrank a newer one.
      lastSeen: EVENT_CREATED_AT,
      reason: 'session_start',
      workspace: 'bluebike4mind',
      sessionId: INSTANCE,
      slug: SLUG,
    });
  });

  it('honors a per-device channel override', async () => {
    ccBridgeDeviceModelMock.findById.mockReturnValue({
      lean: () => Promise.resolve({ _id: DEVICE, userId: USER, hearthChannelId: 'ch-override' }),
    });

    const func = await loadHandler('../ccAgentRegister');
    await func(makeEvent(REGISTER_BODY), {}, makeLogger());

    expect(hearthRepositoryMock.getOwnedChannel).toHaveBeenCalledWith(USER, 'ch-override');
    expect(appendedEvent().channelId).toBe('ch-override');
    expect(hearthRepositoryMock.ensureChannelByName).not.toHaveBeenCalled();
  });

  it('falls back to the default channel when the override is no longer owned', async () => {
    ccBridgeDeviceModelMock.findById.mockReturnValue({
      lean: () => Promise.resolve({ _id: DEVICE, userId: USER, hearthChannelId: 'ch-gone' }),
    });
    hearthRepositoryMock.getOwnedChannel.mockResolvedValue(null);

    const func = await loadHandler('../ccAgentRegister');
    await func(makeEvent(REGISTER_BODY), {}, makeLogger());

    // Dropping the report would be the worse failure: a stale override must not
    // silently remove a live session from the roster.
    expect(appendedEvent().channelId).toBe('ch-default');
  });

  it('a Hearth failure changes neither the ActiveCodeAgent write nor the broadcast', async () => {
    hearthRepositoryMock.ensureChannelByName.mockRejectedValue(new Error('hearth down'));
    const logger = makeLogger();

    const func = await loadHandler('../ccAgentRegister');
    const res = await func(makeEvent(REGISTER_BODY), {}, logger);

    expect(res.statusCode).toBe(200);
    expect(activeCodeAgentRepositoryMock.upsertOnRegister).toHaveBeenCalledTimes(1);
    expect(ccBridgeDeviceRepositoryMock.touch).toHaveBeenCalledWith(DEVICE);
    expect(sendToClientMock).toHaveBeenCalledWith(
      USER,
      'https://ws.example.com/dev',
      expect.objectContaining({ action: 'tavern_scene_broadcast' }),
      { sourceFilter: 'web' }
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Presence report failed'), expect.any(Error));
  });
});

describe('cc_agent_event dual-write', () => {
  const statusBody = (status: string) => ({
    action: 'cc_agent_event',
    accessToken: 'tok',
    instanceId: INSTANCE,
    timestamp: new Date().toISOString(),
    event: { type: 'status', status, text: 'BAIT-status-summary' },
  });

  it('reports the status VALUE as the reason and drops the status text summary', async () => {
    const func = await loadHandler('../ccAgentEvent');
    await func(makeEvent(statusBody('awaiting_permission')), {}, makeLogger());

    const appended = appendedEvent();
    expect(appended.machine.payload.reason).toBe('awaiting_permission');
    expect(appended.human.text).toBe(`bluebike4mind (${SLUG}) needs permission`);
    // The Tavern's own summary path is untouched by the dual-write.
    expect(activeCodeAgentRepositoryMock.updateStatus).toHaveBeenCalledWith(
      INSTANCE,
      'awaiting_permission',
      'BAIT-status-summary'
    );
    expectNoBait();
  });

  it('carries the status through to the roster row verbatim', async () => {
    const func = await loadHandler('../ccAgentEvent');

    // The roster derives its state from `reason` through presenceStateForReason,
    // which maps each CcAgentStatus to itself - so the status must arrive
    // unmapped and unrenamed or the row lands on the wrong state. That identity
    // mapping is pinned in packages/database's presence-projection test; here we
    // prove the bridge feeds it the raw status value.
    await func(makeEvent(statusBody('awaiting_permission')), {}, makeLogger());
    await func(makeEvent(statusBody('running')), {}, makeLogger());

    const reasons = hearthRepositoryMock.upsertPresence.mock.calls.map(([row]) => (row as { reason: string }).reason);
    expect(reasons).toEqual(['awaiting_permission', 'running']);
  });

  it('ignores non-status events - message and tool traffic is content', async () => {
    const func = await loadHandler('../ccAgentEvent');
    await func(
      makeEvent({
        action: 'cc_agent_event',
        accessToken: 'tok',
        instanceId: INSTANCE,
        timestamp: new Date().toISOString(),
        event: { type: 'message', role: 'assistant', text: 'BAIT-message-text' },
      }),
      {},
      makeLogger()
    );

    expect(hearthRepositoryMock.store.appendEvent).not.toHaveBeenCalled();
    expect(hearthRepositoryMock.upsertPresence).not.toHaveBeenCalled();
    expect(activeCodeAgentRepositoryMock.touch).toHaveBeenCalledWith(INSTANCE, 'BAIT-message-text');
  });

  it('a Hearth failure leaves the status write and the metadata broadcast intact', async () => {
    // Either half of the dual-write can fail independently; neither may cost the
    // Tavern its status update.
    for (const breakIt of [
      () => hearthRepositoryMock.store.appendEvent.mockRejectedValue(new Error('log down')),
      () => hearthRepositoryMock.upsertPresence.mockRejectedValue(new Error('roster down')),
    ]) {
      vi.clearAllMocks();
      applyMockDefaults();
      breakIt();
      const logger = makeLogger();

      const func = await loadHandler('../ccAgentEvent');
      const res = await func(makeEvent(statusBody('idle')), {}, logger);

      expect(res.statusCode).toBe(200);
      expect(activeCodeAgentRepositoryMock.updateStatus).toHaveBeenCalledTimes(1);
      expect(sendToClientMock).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Presence report failed'), expect.any(Error));
    }
  });
});

describe('cc_agent_disconnect dual-write', () => {
  const DISCONNECT_BODY = {
    action: 'cc_agent_disconnect',
    accessToken: 'tok',
    instanceId: INSTANCE,
    reason: 'BAIT-disconnect-reason',
  };

  it('reports a disconnect without forwarding the caller-supplied reason string', async () => {
    const func = await loadHandler('../ccAgentDisconnect');
    await func(makeEvent(DISCONNECT_BODY), {}, makeLogger());

    const appended = appendedEvent();
    expect(appended.machine.payload.reason).toBe('disconnected');
    expect(appended.human.text).toBe(`bluebike4mind (${SLUG}) disconnected`);
    // The roster must read gone, not merely quiet - and never still running.
    expect(upsertedPresence().reason).toBe('disconnected');
    expectNoBait();
  });

  it('a Hearth failure still despawns the sprite', async () => {
    hearthRepositoryMock.ensureActor.mockRejectedValue(new Error('hearth down'));
    const func = await loadHandler('../ccAgentDisconnect');
    const res = await func(makeEvent(DISCONNECT_BODY), {}, makeLogger());

    expect(res.statusCode).toBe(200);
    expect(activeCodeAgentRepositoryMock.removeByInstanceId).toHaveBeenCalledWith(INSTANCE);
    expect(sendToClientMock).toHaveBeenCalledTimes(1);
  });
});

describe('$disconnect sweep dual-write', () => {
  const swept = [{ instanceId: INSTANCE, deviceId: DEVICE, workspaceName: 'bluebike4mind', source: 'claude' as const }];

  it('reports every swept session and resolves the override from its device', async () => {
    activeCodeAgentRepositoryMock.removeByConnectionId.mockResolvedValue(swept);
    ccBridgeDeviceRepositoryMock.findById.mockResolvedValue({
      _id: DEVICE,
      userId: USER,
      hearthChannelId: 'ch-override',
    });

    const func = await loadHandler('../disconnect');
    const res = await func(makeEvent({}), {}, makeLogger());

    expect(res.statusCode).toBe(200);
    const appended = appendedEvent();
    expect(appended.channelId).toBe('ch-override');
    expect(appended.machine.payload.reason).toBe('disconnected');
    expect(appended.machine.payload.slug).toBe(SLUG);
    const row = upsertedPresence();
    expect(row.channelId).toBe('ch-override');
    expect(row.reason).toBe('disconnected');
    expectNoBait();
  });

  it('appends nothing when the connection owned no code agents', async () => {
    const func = await loadHandler('../disconnect');
    await func(makeEvent({}), {}, makeLogger());
    expect(hearthRepositoryMock.store.appendEvent).not.toHaveBeenCalled();
    expect(hearthRepositoryMock.upsertPresence).not.toHaveBeenCalled();
  });

  it('a Hearth failure does not stop the sweep or the despawn broadcast', async () => {
    activeCodeAgentRepositoryMock.removeByConnectionId.mockResolvedValue(swept);
    hearthRepositoryMock.ensureChannelByName.mockRejectedValue(new Error('hearth down'));
    ccBridgeDeviceRepositoryMock.findById.mockResolvedValue({ _id: DEVICE, userId: USER });
    const logger = makeLogger();

    const func = await loadHandler('../disconnect');
    const res = await func(makeEvent({}), {}, logger);

    expect(res.statusCode).toBe(200);
    expect(sendToClientMock).toHaveBeenCalledWith(
      USER,
      'https://ws.example.com/dev',
      expect.objectContaining({ action: 'tavern_scene_broadcast' })
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Presence report failed'), expect.any(Error));
  });
});

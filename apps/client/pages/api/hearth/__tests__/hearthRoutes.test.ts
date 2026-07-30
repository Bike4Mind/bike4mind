import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const {
  getOwnedChannelMock,
  ensureChannelByNameMock,
  ensureActorMock,
  createChannelMock,
  listChannelsForUserMock,
  tailEventsMock,
  actorNamesByIdMock,
  upsertPresenceMock,
  presenceForChannelMock,
  storeMock,
  sendToClientMock,
  featureGateMock,
  gateKeys,
  hearthLogAppendMock,
  hearthLogCatchupMock,
} = vi.hoisted(() => {
  const storeMock = {
    appendEvent: vi.fn(),
    eventsSince: vi.fn(),
    getCursor: vi.fn(),
    setCursor: vi.fn(),
  };
  // Plain array so import-time gate registrations survive vi.clearAllMocks().
  const gateKeys: string[] = [];
  return {
    gateKeys,
    getOwnedChannelMock: vi.fn(),
    ensureChannelByNameMock: vi.fn(),
    ensureActorMock: vi.fn(),
    createChannelMock: vi.fn(),
    listChannelsForUserMock: vi.fn(),
    tailEventsMock: vi.fn(),
    actorNamesByIdMock: vi.fn(),
    upsertPresenceMock: vi.fn(),
    presenceForChannelMock: vi.fn(),
    storeMock,
    sendToClientMock: vi.fn(),
    featureGateMock: vi.fn((key: string) => {
      gateKeys.push(key);
      return vi.fn();
    }),
    hearthLogAppendMock: vi.fn(),
    hearthLogCatchupMock: vi.fn(),
  };
});

// baseApi() chain mock: records .use() middlewares, exposes the FINAL handler
// of each verb (per-route middleware like csrf/rate-limit is skipped so the
// business logic runs directly).
vi.mock('@server/middlewares/baseApi', () => ({
  // Records the CONFIG and the full middleware chain, not just the terminal
  // handler. Without `_config` no test could see a route's requiredScopes, so a
  // suite that read as scope coverage would have passed with requiredScopes: [].
  baseApi: (config?: unknown) => {
    const routes: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const middleware: Record<string, unknown[]> = {};
    const uses: unknown[] = [];
    const chain = {
      use: (mw: unknown) => {
        uses.push(mw);
        return chain;
      },
      get: (...handlers: unknown[]) => {
        routes.get = handlers[handlers.length - 1] as (typeof routes)['get'];
        middleware.get = handlers.slice(0, -1);
        return chain;
      },
      post: (...handlers: unknown[]) => {
        routes.post = handlers[handlers.length - 1] as (typeof routes)['post'];
        middleware.post = handlers.slice(0, -1);
        return chain;
      },
      _routes: routes,
      _middleware: middleware,
      _uses: uses,
      _config: config,
    };
    return chain;
  },
}));
// Records the options each route asks for, so a limit can be asserted by value
// rather than by "some middleware is present".
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => Object.assign(vi.fn(), { _rateLimit: options }),
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => vi.fn() }));
vi.mock('@server/middlewares/requireUser', () => ({ requireUser: vi.fn() }));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: featureGateMock }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: sendToClientMock }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://test' } } }));
vi.mock('@bike4mind/database', () => ({
  MAX_PRESENCE_FIELD_LENGTH: 200,
  hearthRepository: {
    store: storeMock,
    getOwnedChannel: getOwnedChannelMock,
    ensureChannelByName: ensureChannelByNameMock,
    ensureActor: ensureActorMock,
    createChannel: createChannelMock,
    listChannelsForUser: listChannelsForUserMock,
    tailEvents: tailEventsMock,
    actorNamesById: actorNamesByIdMock,
    upsertPresence: upsertPresenceMock,
    presenceForChannel: presenceForChannelMock,
  },
}));
vi.mock('@bike4mind/hearth', async importOriginal => ({
  // Real zod schemas from the package, but a controllable HearthLog.
  ...(await importOriginal<Record<string, unknown>>()),
  HearthLog: vi.fn(function () {
    return { append: hearthLogAppendMock, catchup: hearthLogCatchupMock };
  }),
}));

type Handler = (req: Request, res: Response) => Promise<unknown>;
type MockedRouter = {
  _routes: Record<string, Handler>;
  _middleware: Record<string, unknown[]>;
  _uses: unknown[];
  _config?: { requiredScopes?: string[] };
};

/** The rate-limit options a route registered for a verb, or undefined if none. */
function rateLimitOptions(router: MockedRouter, verb: 'get' | 'post'): unknown {
  const tagged = (router._middleware[verb] ?? []).find(mw => (mw as { _rateLimit?: unknown })._rateLimit);
  return (tagged as { _rateLimit?: unknown } | undefined)?._rateLimit;
}

const eventsRouter = (await import('../events')).default as unknown as MockedRouter;
const catchupRouter = (await import('../catchup')).default as unknown as MockedRouter;
const channelsRouter = (await import('../channels')).default as unknown as MockedRouter;
const presenceRouter = (await import('../presence')).default as unknown as MockedRouter;

const DOMAIN_EVENT = {
  id: 'ev-1',
  channelId: 'ch-1',
  seq: 1,
  actorId: 'actor-1',
  kind: 'message' as const,
  human: { text: 'hi', format: 'md' as const },
  machine: undefined,
  refs: {},
  createdAt: new Date('2026-07-22T00:00:00Z'),
};

const makeRes = () => {
  const res = { statusCode: 200, body: undefined as unknown } as unknown as Response & {
    statusCode: number;
    body: unknown;
  };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn((payload: unknown) => {
    res.body = payload;
    return res;
  }) as unknown as Response['json'];
  return res;
};

const makeReq = (body: unknown, query: unknown = {}) =>
  ({
    user: { id: 'u1', username: 'erik' },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    body,
    query,
  }) as unknown as Request;

const presenceRow = (actorId: string, state: string, lastSeen: string, extra: Record<string, unknown> = {}) => ({
  actorId: { toString: () => actorId },
  state,
  lastSeen: new Date(lastSeen),
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  getOwnedChannelMock.mockResolvedValue({ _id: 'ch-1', nextSeq: 5, userId: 'u1' });
  ensureChannelByNameMock.mockResolvedValue({ _id: 'ch-default', nextSeq: 0, userId: 'u1' });
  ensureActorMock.mockResolvedValue({ _id: { toString: () => 'actor-1' }, displayName: 'erik' });
  hearthLogAppendMock.mockResolvedValue(DOMAIN_EVENT);
  hearthLogCatchupMock.mockResolvedValue([DOMAIN_EVENT]);
  actorNamesByIdMock.mockResolvedValue(new Map([['actor-1', 'erik']]));
  storeMock.getCursor.mockResolvedValue(1);
  tailEventsMock.mockResolvedValue([DOMAIN_EVENT]);
  sendToClientMock.mockResolvedValue(undefined);
  upsertPresenceMock.mockResolvedValue(null);
  presenceForChannelMock.mockResolvedValue([]);
});

describe('route wiring', () => {
  it('every hearth route registers the EnableHearth feature gate', () => {
    // requireFeatureEnabled runs at module import, once per route file.
    expect(gateKeys.filter(k => k === 'EnableHearth')).toHaveLength(4);
    for (const router of [eventsRouter, catchupRouter, channelsRouter, presenceRouter]) {
      expect(router._uses.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('POST /api/hearth/events', () => {
  const post = () => eventsRouter._routes.post;

  it('404s when the channel is not owned by the caller', async () => {
    getOwnedChannelMock.mockResolvedValue(null);
    const res = makeRes();
    await expect(post()(makeReq({ channelId: 'ch-x', human: { text: 'hi' } }), res)).rejects.toThrow(
      /channel not found/i
    );
    expect(hearthLogAppendMock).not.toHaveBeenCalled();
  });

  it('channelName resolves-or-creates and never runs the ownership check', async () => {
    await post()(makeReq({ channelName: 'agents', human: { text: 'hi' } }), makeRes());
    expect(ensureChannelByNameMock).toHaveBeenCalledWith('u1', 'agents');
    expect(getOwnedChannelMock).not.toHaveBeenCalled();
    expect(hearthLogAppendMock).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'ch-default' }));
  });

  it('channelId keeps its ownership check and is mutually exclusive with channelName', async () => {
    // Ownership is still enforced for an id: another user's channel is a 404.
    getOwnedChannelMock.mockResolvedValue(null);
    await expect(post()(makeReq({ channelId: 'ch-theirs', human: { text: 'hi' } }), makeRes())).rejects.toThrow(
      /channel not found/i
    );

    for (const body of [
      { channelId: 'ch-1', channelName: 'agents', human: { text: 'hi' } },
      { human: { text: 'hi' } },
    ]) {
      await expect(post()(makeReq(body), makeRes())).rejects.toThrow(/exactly one of channelId or channelName/i);
    }
    expect(ensureChannelByNameMock).not.toHaveBeenCalled();
    expect(hearthLogAppendMock).not.toHaveBeenCalled();
  });

  it('scopes the actor to the authenticated user (defaults to human actor)', async () => {
    const res = makeRes();
    await post()(makeReq({ channelId: 'ch-1', human: { text: 'hi' } }), res);
    expect(ensureActorMock).toHaveBeenCalledWith('u1', 'human', 'erik');
    expect(hearthLogAppendMock).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'actor-1' }));
  });

  it('actor override stays owned by the caller and cannot claim a reserved kind', async () => {
    const res = makeRes();
    await post()(makeReq({ channelId: 'ch-1', human: { text: 'hi' }, actor: { displayName: 'hook' } }), res);
    expect(ensureActorMock).toHaveBeenCalledWith('u1', 'agent', 'hook');

    // 'system' and 'human' are both reserved: the human actor is derived from the
    // session, so no credential can forge an event that renders as the account owner.
    for (const kind of ['system', 'human']) {
      await expect(
        post()(makeReq({ channelId: 'ch-1', human: { text: 'hi' }, actor: { kind, displayName: 'erik' } }), makeRes())
      ).rejects.toThrow();
    }
    expect(ensureActorMock).toHaveBeenCalledTimes(1);
  });

  it('caps the serialized machine payload', async () => {
    const oversized = {
      channelId: 'ch-1',
      human: { text: 'hi' },
      machine: { schema: 's@1', payload: { blob: 'A'.repeat(70 * 1024) } },
    };
    await expect(post()(makeReq(oversized), makeRes())).rejects.toThrow(/payload exceeds/i);
    expect(hearthLogAppendMock).not.toHaveBeenCalled();

    // A realistic typed payload still passes.
    await post()(
      makeReq({ channelId: 'ch-1', human: { text: 'hi' }, machine: { schema: 's@1', payload: { ok: true } } }),
      makeRes()
    );
    expect(hearthLogAppendMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an API key that lacks hearth:write', async () => {
    const req = makeReq({ channelId: 'ch-1', human: { text: 'hi' } });
    (req as unknown as { apiKeyInfo: { scopes: string[] } }).apiKeyInfo = { scopes: ['hearth:read'] };
    await expect(post()(req, makeRes())).rejects.toThrow(/hearth:write/);
    expect(hearthLogAppendMock).not.toHaveBeenCalled();
  });

  it('accepts an API key holding hearth:write, and admin keys', async () => {
    for (const scopes of [['hearth:write'], ['admin:*']]) {
      const req = makeReq({ channelId: 'ch-1', human: { text: 'hi' } });
      (req as unknown as { apiKeyInfo: { scopes: string[] } }).apiKeyInfo = { scopes };
      await post()(req, makeRes());
    }
    expect(hearthLogAppendMock).toHaveBeenCalledTimes(2);
  });

  it('still returns 201 with the event when fanout throws', async () => {
    sendToClientMock.mockRejectedValue(new Error('gateway down'));
    const res = makeRes();
    await post()(makeReq({ channelId: 'ch-1', human: { text: 'hi' } }), res);
    expect(res.statusCode).toBe(201);
    expect((res.body as { event: { id: string } }).event.id).toBe('ev-1');
  });

  it('publishes hearth_event to the owner on success', async () => {
    const res = makeRes();
    await post()(makeReq({ channelId: 'ch-1', human: { text: 'hi' } }), res);
    expect(sendToClientMock).toHaveBeenCalledWith(
      'u1',
      'wss://test',
      expect.objectContaining({ action: 'hearth_event' })
    );
  });
});

describe('POST /api/hearth/events presence projection', () => {
  const post = () => eventsRouter._routes.post;

  const PRESENCE_BODY = {
    channelId: 'ch-1',
    kind: 'presence',
    human: { text: 'agent needs permission', format: 'text' },
    machine: {
      schema: 'hearth.claude-code-hook@1',
      payload: {
        hook_event_name: 'Notification',
        session_id: 'sess-1',
        slug: 'amber-otter',
        workspace: 'some-repo',
        activity: { reason: 'permission_prompt', tool: 'Bash', permission_mode: 'default', background_tasks: 2 },
      },
    },
  };

  beforeEach(() => {
    hearthLogAppendMock.mockResolvedValue({ ...DOMAIN_EVENT, kind: 'presence' });
  });

  it('projects the hook payload onto the roster row', async () => {
    await post()(makeReq(PRESENCE_BODY), makeRes());
    expect(upsertPresenceMock).toHaveBeenCalledWith({
      channelId: 'ch-1',
      actorId: 'actor-1',
      userId: 'u1',
      lastSeen: DOMAIN_EVENT.createdAt,
      reason: 'permission_prompt',
      workspace: 'some-repo',
      tool: 'Bash',
      permissionMode: 'default',
      effort: undefined,
      sessionId: 'sess-1',
      slug: 'amber-otter',
      subagent: undefined,
      backgroundTasks: 2,
    });
  });

  it('leaves the roster alone for non-presence events', async () => {
    hearthLogAppendMock.mockResolvedValue(DOMAIN_EVENT);
    await post()(makeReq({ channelId: 'ch-1', human: { text: 'hi' } }), makeRes());
    expect(upsertPresenceMock).not.toHaveBeenCalled();
  });

  it('still returns 201 when the projection write throws', async () => {
    // The log is the source of truth: a derived-state failure must not cost the
    // caller their append.
    upsertPresenceMock.mockRejectedValue(new Error('index build in progress'));
    const req = makeReq(PRESENCE_BODY);
    const res = makeRes();
    await post()(req, res);
    expect(res.statusCode).toBe(201);
    expect(req.logger?.warn).toHaveBeenCalledWith(expect.stringMatching(/presence projection failed/i));
  });
});

describe('GET /api/hearth/presence', () => {
  const get = () => presenceRouter._routes.get;

  it('404s when the channel is not owned by the caller', async () => {
    getOwnedChannelMock.mockResolvedValue(null);
    await expect(get()(makeReq({}, { channelId: 'ch-x' }), makeRes())).rejects.toThrow(/channel not found/i);
    expect(presenceForChannelMock).not.toHaveBeenCalled();
  });

  // This case used to be titled "a key with only hearth:read may read the
  // roster" while asserting nothing of the kind: scope enforcement happens in
  // baseApi's requiredScopes, which the harness discarded, and the handler never
  // reads apiKeyInfo - so it passed identically with no apiKeyInfo at all, and
  // would have passed with requiredScopes: []. Split into the two claims that
  // are actually checkable here.
  it('declares the read scope list, so a read-only key is admitted', () => {
    // OR semantics, matching the sibling routes: any one of these suffices.
    expect(presenceRouter._config?.requiredScopes).toEqual(['hearth:read', 'hearth:write', 'admin:*']);
  });

  it('consumes nothing: reading a roster advances no cursor and mints no actor', async () => {
    await get()(makeReq({}, { channelId: 'ch-1' }), makeRes());
    expect(presenceForChannelMock).toHaveBeenCalledWith('u1', 'ch-1');
    expect(storeMock.setCursor).not.toHaveBeenCalled();
    expect(ensureActorMock).not.toHaveBeenCalled();
  });

  // Was the only hearth route with no limit at all, and it is the most expensive
  // one: the roster aggregation sorts on an $addFields key, so no index can serve
  // it, over a collection that grows one permanent row per session.
  it('is rate limited on the same budget as the other reads', () => {
    expect(rateLimitOptions(presenceRouter, 'get')).toEqual({ limit: 120, windowMs: 60000 });
  });

  it('returns the repository order untouched (needs-you-first, not by recency)', async () => {
    presenceForChannelMock.mockResolvedValue([
      presenceRow('a-blocked', 'awaiting_permission', '2026-07-27T10:00:05Z', { reason: 'permission_prompt' }),
      presenceRow('a-working', 'running', '2026-07-27T10:00:20Z', { tool: 'Bash' }),
      presenceRow('a-idle', 'idle', '2026-07-27T10:00:30Z'),
    ]);
    actorNamesByIdMock.mockResolvedValue(new Map([['a-blocked', 'agent one']]));

    const res = makeRes();
    await get()(makeReq({}, { channelId: 'ch-1' }), res);

    const body = res.body as { presence: Array<{ actorId: string; state: string }>; staleAfterMs: number };
    // Sorting by lastSeen would have inverted this; the blocked actor stays first.
    expect(body.presence.map(p => p.actorId)).toEqual(['a-blocked', 'a-working', 'a-idle']);
    expect(body.presence[0]).toMatchObject({
      state: 'awaiting_permission',
      actorName: 'agent one',
      reason: 'permission_prompt',
      lastSeen: '2026-07-27T10:00:05.000Z',
    });
    expect(body.staleAfterMs).toBeGreaterThan(0);
  });

  it('requires a channelId', async () => {
    await expect(get()(makeReq({}, {}), makeRes())).rejects.toThrow();
  });
});

describe('POST /api/hearth/catchup', () => {
  const post = () => catchupRouter._routes.post;

  it('404s on unowned channels before touching cursors', async () => {
    getOwnedChannelMock.mockResolvedValue(null);
    await expect(post()(makeReq({ channelId: 'ch-x' }), makeRes())).rejects.toThrow(/channel not found/i);
    expect(hearthLogCatchupMock).not.toHaveBeenCalled();
  });

  it('cursor mode passes advance through and reports the post-call cursor', async () => {
    const res = makeRes();
    await post()(makeReq({ channelId: 'ch-1', advance: false, limit: 10 }), res);
    expect(hearthLogCatchupMock).toHaveBeenCalledWith('actor-1', 'ch-1', { advance: false, limit: 10 });
    expect((res.body as { cursor: number }).cursor).toBe(1);
  });

  it('a read-only key may tail but may not advance a cursor', async () => {
    const readOnly = () => {
      const req = makeReq({ channelId: 'ch-1' });
      (req as unknown as { apiKeyInfo: { scopes: string[] } }).apiKeyInfo = { scopes: ['hearth:read'] };
      return req;
    };

    // Tail is cursor-free, so a read key is enough.
    await post()(Object.assign(readOnly(), { body: { channelId: 'ch-1', tail: 10 } }), makeRes());
    expect(tailEventsMock).toHaveBeenCalledTimes(1);

    // Advancing consumes events out from under other readers: write scope required.
    await expect(post()(readOnly(), makeRes())).rejects.toThrow(/hearth:write/);
    expect(hearthLogCatchupMock).not.toHaveBeenCalled();

    // Peek mode (advance:false) leaves cursors alone, so read scope suffices.
    await post()(Object.assign(readOnly(), { body: { channelId: 'ch-1', advance: false } }), makeRes());
    expect(hearthLogCatchupMock).toHaveBeenCalledWith('actor-1', 'ch-1', { advance: false, limit: undefined });
  });

  it('tail mode never resolves an actor nor touches any cursor', async () => {
    const res = makeRes();
    await post()(makeReq({ channelId: 'ch-1', tail: 50 }), res);
    expect(tailEventsMock).toHaveBeenCalledWith('ch-1', 50);
    expect(ensureActorMock).not.toHaveBeenCalled();
    expect(hearthLogCatchupMock).not.toHaveBeenCalled();
    expect(storeMock.setCursor).not.toHaveBeenCalled();
    expect((res.body as { cursor: number }).cursor).toBe(5);
  });
});

describe('/api/hearth/channels', () => {
  it('POST maps a duplicate-name unique violation to a 400', async () => {
    const dup = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    createChannelMock.mockRejectedValue(dup);
    await expect(channelsRouter._routes.post(makeReq({ name: 'ops' }), makeRes())).rejects.toThrow(/already exists/i);
  });

  it('GET lists only the callers channels', async () => {
    listChannelsForUserMock.mockResolvedValue([
      { _id: { toString: () => 'ch-1' }, name: 'ops', createdAt: new Date(), gatewayActorId: undefined },
    ]);
    const res = makeRes();
    await channelsRouter._routes.get(makeReq({}), res);
    expect(listChannelsForUserMock).toHaveBeenCalledWith('u1');
    expect((res.body as { channels: Array<{ id: string }> }).channels[0].id).toBe('ch-1');
  });
});

/**
 * Scope declarations for EVERY hearth route, not just presence.
 *
 * `requiredScopes` is enforced inside baseApi, which this suite mocks, so no test
 * here can prove enforcement - what it CAN prove is that each route asks for the
 * right list, which is the part a refactor silently changes. Before the harness
 * recorded the config, nothing in the suite asserted any route's scopes at all.
 */
describe('hearth route scope declarations', () => {
  const READ_OR_WRITE = ['hearth:read', 'hearth:write', 'admin:*'];

  it.each([
    ['channels', () => channelsRouter, READ_OR_WRITE],
    ['catchup', () => catchupRouter, READ_OR_WRITE],
    ['presence', () => presenceRouter, READ_OR_WRITE],
    // events is the asymmetric one and deliberately so: appending is a write, so
    // a hearth:read key must NOT reach it. Pinning the difference is the point -
    // widening this list to match its siblings would hand every read-only key the
    // ability to append to the log.
    ['events', () => eventsRouter, ['hearth:write', 'admin:*']],
  ])('%s declares its scope list', (_name, router, expected) => {
    expect(router()._config?.requiredScopes).toEqual(expected);
  });

  it('no route omits requiredScopes entirely', () => {
    // An undefined list is the dangerous default: baseApi would apply no scope
    // constraint at all, and every assertion above would still read as coverage.
    for (const router of [channelsRouter, catchupRouter, presenceRouter, eventsRouter]) {
      expect(router._config?.requiredScopes).toBeDefined();
      expect(router._config?.requiredScopes?.length).toBeGreaterThan(0);
    }
  });
});

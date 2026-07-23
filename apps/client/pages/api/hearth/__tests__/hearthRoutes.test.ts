import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const {
  getOwnedChannelMock,
  ensureActorMock,
  createChannelMock,
  listChannelsForUserMock,
  tailEventsMock,
  actorNamesByIdMock,
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
    ensureActorMock: vi.fn(),
    createChannelMock: vi.fn(),
    listChannelsForUserMock: vi.fn(),
    tailEventsMock: vi.fn(),
    actorNamesByIdMock: vi.fn(),
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
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const uses: unknown[] = [];
    const chain = {
      use: (mw: unknown) => {
        uses.push(mw);
        return chain;
      },
      get: (...handlers: unknown[]) => {
        routes.get = handlers[handlers.length - 1] as (typeof routes)['get'];
        return chain;
      },
      post: (...handlers: unknown[]) => {
        routes.post = handlers[handlers.length - 1] as (typeof routes)['post'];
        return chain;
      },
      _routes: routes,
      _uses: uses,
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => vi.fn() }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => vi.fn() }));
vi.mock('@server/middlewares/requireUser', () => ({ requireUser: vi.fn() }));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: featureGateMock }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: sendToClientMock }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://test' } } }));
vi.mock('@bike4mind/database', () => ({
  hearthRepository: {
    store: storeMock,
    getOwnedChannel: getOwnedChannelMock,
    ensureActor: ensureActorMock,
    createChannel: createChannelMock,
    listChannelsForUser: listChannelsForUserMock,
    tailEvents: tailEventsMock,
    actorNamesById: actorNamesByIdMock,
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
type MockedRouter = { _routes: Record<string, Handler>; _uses: unknown[] };

const eventsRouter = (await import('../events')).default as unknown as MockedRouter;
const catchupRouter = (await import('../catchup')).default as unknown as MockedRouter;
const channelsRouter = (await import('../channels')).default as unknown as MockedRouter;

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

const makeReq = (body: unknown) =>
  ({
    user: { id: 'u1', username: 'erik' },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    body,
  }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  getOwnedChannelMock.mockResolvedValue({ _id: 'ch-1', nextSeq: 5, userId: 'u1' });
  ensureActorMock.mockResolvedValue({ _id: { toString: () => 'actor-1' }, displayName: 'erik' });
  hearthLogAppendMock.mockResolvedValue(DOMAIN_EVENT);
  hearthLogCatchupMock.mockResolvedValue([DOMAIN_EVENT]);
  actorNamesByIdMock.mockResolvedValue(new Map([['actor-1', 'erik']]));
  storeMock.getCursor.mockResolvedValue(1);
  tailEventsMock.mockResolvedValue([DOMAIN_EVENT]);
  sendToClientMock.mockResolvedValue(undefined);
});

describe('route wiring', () => {
  it('every hearth route registers the EnableHearth feature gate', () => {
    // requireFeatureEnabled runs at module import, once per route file.
    expect(gateKeys.filter(k => k === 'EnableHearth')).toHaveLength(3);
    for (const router of [eventsRouter, catchupRouter, channelsRouter]) {
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

  it('scopes the actor to the authenticated user (defaults to human actor)', async () => {
    const res = makeRes();
    await post()(makeReq({ channelId: 'ch-1', human: { text: 'hi' } }), res);
    expect(ensureActorMock).toHaveBeenCalledWith('u1', 'human', 'erik');
    expect(hearthLogAppendMock).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'actor-1' }));
  });

  it('actor override stays owned by the caller and cannot claim kind system', async () => {
    const res = makeRes();
    await post()(makeReq({ channelId: 'ch-1', human: { text: 'hi' }, actor: { displayName: 'hook' } }), res);
    expect(ensureActorMock).toHaveBeenCalledWith('u1', 'agent', 'hook');

    await expect(
      post()(
        makeReq({ channelId: 'ch-1', human: { text: 'hi' }, actor: { kind: 'system', displayName: 'x' } }),
        makeRes()
      )
    ).rejects.toThrow();
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

/**
 * A sharee reading or updating a message via this route used to get the owner's verbatim
 * promptMeta.functionCalls[].returnValue back - the same class of leak the quests/[id] route
 * was fixed for, missed here because this handler returns the raw document instead of building
 * a response object.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// The real baseApi() returns a next-connect router: each .get/.put/.delete registers a handler
// for that method and returns the SAME router, so they chain (.get(a).put(b).delete(c)), and the
// final router itself is invoked as `handler(req, res)`, dispatching on req.method. Mocked here
// closely enough to support that shape rather than a bare `(fn) => fn`, which breaks the chain.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    type Mw = (req: unknown, res: unknown, next: () => void) => unknown;
    const used: Mw[] = [];
    const compose =
      (...handlers: Mw[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of [...used, ...handlers]) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = (mw: Mw) => {
      used.push(mw);
      return chain;
    };
    chain.get = compose;
    chain.put = compose;
    chain.delete = compose;
    return chain;
  },
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
    res.status(405).json({ error: 'Method not allowed' }),
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: any) => fn,
}));

const mockSessionFindById = vi.fn();
const mockQuestFindBySessionIdAndId = vi.fn();
const mockQuestUpdate = vi.fn();
vi.mock('@bike4mind/database', () => ({
  sessionRepository: {
    findById: (...a: any[]) => mockSessionFindById(...a),
    shareable: { findUpdateAccessById: async () => ({ id: 'sess-1' }) },
  },
  questRepository: {
    findBySessionIdAndId: (...a: any[]) => mockQuestFindBySessionIdAndId(...a),
    updateInSession: (...a: any[]) => mockQuestUpdate(...a),
  },
}));

vi.mock('@bike4mind/services', () => ({
  sessionService: { deleteSessionMessage: vi.fn() },
}));

import handler from '@pages/api/sessions/[id]/chat/[messageId]/index';

function fire({ method = 'GET', body = {} }: { method?: string; body?: unknown } = {}) {
  const { req, res } = createMocks({ method, query: { id: 'sess-1', messageId: 'quest-1' } });
  (req as any).body = body;
  (req as any).user = { id: 'jwt-user' };
  return { req: req as any, res: res as any };
}

const messageWithFunctionCalls = () => ({
  id: 'quest-1',
  sessionId: 'sess-1',
  reply: 'hi',
  replies: ['hi'],
  pendingAction: { tool: 'create_document', params: { body: 'PRIVATE DRAFT' }, ts: 1 },
  promptMeta: {
    functionCalls: [
      { name: 'web_search', parameters: {}, id: 'call_1', returnValue: 'PRIVATE TOOL OUTPUT', success: true },
    ],
  },
});

describe('GET/PUT /api/sessions/[id]/chat/[messageId] - non-owner redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuestFindBySessionIdAndId.mockResolvedValue(messageWithFunctionCalls());
    mockQuestUpdate.mockResolvedValue(messageWithFunctionCalls());
  });

  // The gate that matters: session access alone is not enough. A caller who owns THEIR OWN
  // session (so userHasAccess passes) must not be able to read a quest bound to a DIFFERENT
  // session just by naming its id - findBySessionIdAndId returns null for a mismatched pair,
  // where a bare findById(messageId) would have returned the other session's quest.
  it('GET 404s when messageId belongs to a different session than the one in the URL', async () => {
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'jwt-user', users: [] });
    mockQuestFindBySessionIdAndId.mockResolvedValue(null);
    const { req, res } = fire();

    await expect(handler(req, res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockQuestFindBySessionIdAndId).toHaveBeenCalledWith('sess-1', 'quest-1');
  });

  it('GET strips returnValue for a sharee (jwt-user is not session.userId)', async () => {
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'owner', users: [{ userId: 'jwt-user' }] });
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(JSON.stringify(body)).not.toContain('PRIVATE TOOL OUTPUT');
    expect(JSON.stringify(body)).not.toContain('PRIVATE DRAFT');
    expect(body.promptMeta.functionCalls[0]).toMatchObject({ name: 'web_search', id: 'call_1', success: true });
  });

  it.each(['isGlobalRead', 'isGlobalWrite'] as const)('GET accepts %s and redacts owner-only fields', async flag => {
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'owner', users: [], [flag]: true });
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockQuestFindBySessionIdAndId).toHaveBeenCalledWith('sess-1', 'quest-1');
    const body = res._getJSONData();
    expect(JSON.stringify(body)).not.toContain('PRIVATE TOOL OUTPUT');
    expect(body).not.toHaveProperty('pendingAction');
  });

  it('GET rejects an unrelated user before reading the message', async () => {
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'owner', users: [{ userId: 'someone-else' }] });
    const { req, res } = fire();

    await expect(handler(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(mockQuestFindBySessionIdAndId).not.toHaveBeenCalled();
  });

  it.each(['GET', 'PUT'])('%s binds messages to the resolved session id', async method => {
    const sessionId = 'abcdef0123456789abcdef01';
    mockSessionFindById.mockResolvedValue({ id: sessionId, userId: 'jwt-user', users: [] });
    const { req, res } = fire({ method });
    req.query.id = sessionId.toUpperCase();
    await handler(req, res);

    expect(mockSessionFindById).toHaveBeenCalledWith(sessionId.toUpperCase());
    expect(mockQuestFindBySessionIdAndId).toHaveBeenCalledWith(sessionId, 'quest-1');
    if (method === 'PUT') {
      expect(mockQuestUpdate).toHaveBeenCalledWith(sessionId, expect.objectContaining({ id: 'quest-1' }));
    }
  });

  it('GET leaves returnValue untouched for the session owner', async () => {
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'jwt-user', users: [] });
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(JSON.stringify(body)).toContain('PRIVATE TOOL OUTPUT');
    expect(JSON.stringify(body)).toContain('PRIVATE DRAFT');
  });

  it('PUT strips returnValue for a sharee', async () => {
    // Holds update, because PUT is gated on update-level access; redaction still applies to any
    // non-owner, which is what this asserts.
    mockSessionFindById.mockResolvedValue({
      id: 'sess-1',
      userId: 'owner',
      users: [{ userId: 'jwt-user', permissions: ['read', 'update'] }],
    });
    const { req, res } = fire({ method: 'PUT', body: { reply: 'updated' } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(JSON.stringify(body)).not.toContain('PRIVATE TOOL OUTPUT');
    expect(JSON.stringify(body)).not.toContain('PRIVATE DRAFT');
    expect(body.data.promptMeta.functionCalls[0]).toMatchObject({ name: 'web_search', id: 'call_1', success: true });
  });

  it('PUT leaves returnValue untouched for the session owner', async () => {
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'jwt-user', users: [] });
    const { req, res } = fire({ method: 'PUT', body: { reply: 'updated' } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(JSON.stringify(body)).toContain('PRIVATE TOOL OUTPUT');
    expect(JSON.stringify(body)).toContain('PRIVATE DRAFT');
  });
});

// The response schema is an allowlist: server-only and undeclared document keys must never
// reach the client, whatever the repository hands back.
describe('GET/PUT /api/sessions/[id]/chat/[messageId] - response schema strip', () => {
  const withServerOnlyFields = () => ({
    ...messageWithFunctionCalls(),
    prompt: 'hello',
    embedding: [0.1, 0.2, 0.3],
    slackNotification: { channel: 'C123', threadTs: '1.2' },
    callback: { url: 'https://hook.example.test', apiKeyId: 'key-1' },
    __v: 7,
  });

  const expectStripped = (message: Record<string, unknown>) => {
    expect(message).not.toHaveProperty('embedding');
    expect(message).not.toHaveProperty('slackNotification');
    expect(message).not.toHaveProperty('callback');
    expect(message).not.toHaveProperty('__v');
    expect(message).toMatchObject({ id: 'quest-1', prompt: 'hello', reply: 'hi' });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuestFindBySessionIdAndId.mockResolvedValue(withServerOnlyFields());
    mockQuestUpdate.mockResolvedValue(withServerOnlyFields());
  });

  it('GET withholds embedding, slackNotification, callback and undeclared keys', async () => {
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'jwt-user', users: [] });
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expectStripped(res._getJSONData());
  });

  it('PUT withholds embedding, slackNotification, callback and undeclared keys under data', async () => {
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'jwt-user', users: [] });
    const { req, res } = fire({ method: 'PUT', body: { reply: 'updated' } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body).toMatchObject({ success: true });
    expectStripped(body.data);
  });
});

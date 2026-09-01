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
vi.mock('@server/middlewares/baseApi', () => {
  function createRouter() {
    const handlers: Record<string, any> = {};
    const router: any = (req: any, res: any) => handlers[req.method?.toUpperCase()](req, res);
    router.get = (fn: any) => {
      handlers.GET = fn;
      return router;
    };
    router.put = (fn: any) => {
      handlers.PUT = fn;
      return router;
    };
    router.delete = (fn: any) => {
      handlers.DELETE = fn;
      return router;
    };
    return router;
  }
  return { baseApi: () => createRouter() };
});

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: any) => fn,
}));

const mockSessionFindById = vi.fn();
const mockQuestFindBySessionIdAndId = vi.fn();
const mockQuestUpdate = vi.fn();
vi.mock('@bike4mind/database', () => ({
  sessionRepository: { findById: (...a: any[]) => mockSessionFindById(...a) },
  questRepository: {
    findBySessionIdAndId: (...a: any[]) => mockQuestFindBySessionIdAndId(...a),
    update: (...a: any[]) => mockQuestUpdate(...a),
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
    await handler(req, res);

    expect(mockQuestFindBySessionIdAndId).toHaveBeenCalledWith('sess-1', 'quest-1');
    expect(res._getStatusCode()).toBe(404);
  });

  it('GET strips returnValue for a sharee (jwt-user is not session.userId)', async () => {
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'owner', users: [{ userId: 'jwt-user' }] });
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(JSON.stringify(body)).not.toContain('PRIVATE TOOL OUTPUT');
    expect(body.promptMeta.functionCalls[0]).toMatchObject({ name: 'web_search', id: 'call_1', success: true });
  });

  it('GET leaves returnValue untouched for the session owner', async () => {
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'jwt-user', users: [] });
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(JSON.stringify(body)).toContain('PRIVATE TOOL OUTPUT');
  });

  it('PUT strips returnValue for a sharee', async () => {
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'owner', users: [{ userId: 'jwt-user' }] });
    const { req, res } = fire({ method: 'PUT', body: { reply: 'updated' } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(JSON.stringify(body)).not.toContain('PRIVATE TOOL OUTPUT');
    expect(body.data.promptMeta.functionCalls[0]).toMatchObject({ name: 'web_search', id: 'call_1', success: true });
  });

  it('PUT leaves returnValue untouched for the session owner', async () => {
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'jwt-user', users: [] });
    const { req, res } = fire({ method: 'PUT', body: { reply: 'updated' } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(JSON.stringify(body)).toContain('PRIVATE TOOL OUTPUT');
  });
});

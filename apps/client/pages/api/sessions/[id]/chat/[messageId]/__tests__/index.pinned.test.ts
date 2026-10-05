/**
 * The PUT allow-list admits the pin flag as a boolean only. Without it the pin toggle looked saved
 * (useUpdateQuest writes the React Query cache first) but was dropped server-side.
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

const quest = (pinned?: boolean) => ({ id: 'quest-1', sessionId: 'sess-1', reply: 'hi', pinned });

describe('PUT /api/sessions/[id]/chat/[messageId] - pin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'jwt-user', users: [] });
    mockQuestFindBySessionIdAndId.mockResolvedValue(quest(false));
    mockQuestUpdate.mockResolvedValue(quest(true));
  });

  it.each([true, false])('persists pinned=%j', async pinned => {
    const { req, res } = fire({ method: 'PUT', body: { pinned } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockQuestUpdate).toHaveBeenCalledWith('sess-1', { id: 'quest-1', pinned });
  });

  it.each(['true', 1, null, {}])('ignores a non-boolean pinned %j', async pinned => {
    const { req, res } = fire({ method: 'PUT', body: { pinned } });
    await handler(req, res);

    expect(mockQuestUpdate).toHaveBeenCalledWith('sess-1', { id: 'quest-1' });
  });

  it('rejects a pin from a caller without update access', async () => {
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'owner', users: [] });
    const { req, res } = fire({ method: 'PUT', body: { pinned: true } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(mockQuestUpdate).not.toHaveBeenCalled();
  });
});

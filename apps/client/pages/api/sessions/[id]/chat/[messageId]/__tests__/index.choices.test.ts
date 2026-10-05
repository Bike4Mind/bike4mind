/**
 * The PUT allow-list admits the reply-choice pick, and only the pick: a caller must not be able to
 * rewrite the stored options, or re-pick once the conversation has followed a choice.
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

const options = [
  { label: 'Reformulate', description: 'Re-formulate with all three pools.' },
  { label: 'Extend', description: 'Extend the loaded brief.' },
];

const questWithChoices = (selectedIndex?: number) => ({
  id: 'quest-1',
  sessionId: 'sess-1',
  reply: 'hi',
  replies: ['hi'],
  suggestedChoices: selectedIndex === undefined ? { options } : { options, selectedIndex },
});

describe('PUT /api/sessions/[id]/chat/[messageId] - reply choice pick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'jwt-user', users: [] });
    mockQuestFindBySessionIdAndId.mockResolvedValue(questWithChoices());
    mockQuestUpdate.mockResolvedValue(questWithChoices(1));
  });

  it('records a valid pick against the stored options', async () => {
    const { req, res } = fire({ method: 'PUT', body: { selectedChoiceIndex: 1 } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockQuestUpdate).toHaveBeenCalledWith('sess-1', {
      id: 'quest-1',
      suggestedChoices: { options, selectedIndex: 1 },
    });
  });

  it.each([2, -1, 0.5, '1', null])('ignores an invalid index %j', async selectedChoiceIndex => {
    const { req, res } = fire({ method: 'PUT', body: { selectedChoiceIndex } });
    await handler(req, res);

    expect(mockQuestUpdate).toHaveBeenCalledWith('sess-1', { id: 'quest-1' });
  });

  it('keeps the first pick', async () => {
    mockQuestFindBySessionIdAndId.mockResolvedValue(questWithChoices(0));
    const { req, res } = fire({ method: 'PUT', body: { selectedChoiceIndex: 1 } });
    await handler(req, res);

    expect(mockQuestUpdate).toHaveBeenCalledWith('sess-1', { id: 'quest-1' });
  });

  it('ignores a pick on a quest that offered no choices', async () => {
    mockQuestFindBySessionIdAndId.mockResolvedValue({ id: 'quest-1', sessionId: 'sess-1', reply: 'hi' });
    const { req, res } = fire({ method: 'PUT', body: { selectedChoiceIndex: 0 } });
    await handler(req, res);

    expect(mockQuestUpdate).toHaveBeenCalledWith('sess-1', { id: 'quest-1' });
  });

  it('never accepts options written by the caller', async () => {
    const forged = { options: [{ label: 'Delete', description: 'Delete everything.' }], selectedIndex: 0 };
    const { req, res } = fire({ method: 'PUT', body: { suggestedChoices: forged } });
    await handler(req, res);

    expect(mockQuestUpdate).toHaveBeenCalledWith('sess-1', { id: 'quest-1' });
  });
});

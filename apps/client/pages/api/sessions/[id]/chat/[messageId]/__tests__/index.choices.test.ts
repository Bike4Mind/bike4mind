/**
 * The PUT allow-list. It admits the reply-choice pick, and only the pick: a caller must not be able
 * to rewrite the stored options, or re-pick once the conversation has followed a choice. It admits
 * the pin flag as a boolean only.
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

  it('ignores an index outside the stored options', async () => {
    const { req, res } = fire({ method: 'PUT', body: { selectedChoiceIndex: 2 } });
    await handler(req, res);

    expect(mockQuestUpdate).toHaveBeenCalledWith('sess-1', { id: 'quest-1' });
  });

  it.each([-1, 0.5, '1', null])('rejects a malformed index %j before any write', async selectedChoiceIndex => {
    const { req, res } = fire({ method: 'PUT', body: { selectedChoiceIndex } });

    await expect(handler(req, res)).rejects.toBeDefined();
    expect(mockQuestUpdate).not.toHaveBeenCalled();
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

describe('PUT /api/sessions/[id]/chat/[messageId] - pin', () => {
  const quest = (pinned?: boolean) => ({ id: 'quest-1', sessionId: 'sess-1', reply: 'hi', pinned });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'jwt-user', users: [] });
    mockQuestFindBySessionIdAndId.mockResolvedValue(quest(false));
    mockQuestUpdate.mockImplementation(async (_sessionId: string, update: object) => ({ ...quest(), ...update }));
  });

  it.each([true, false])('persists pinned=%j', async pinned => {
    mockQuestFindBySessionIdAndId.mockResolvedValue(quest(!pinned));
    const { req, res } = fire({ method: 'PUT', body: { pinned } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockQuestUpdate).toHaveBeenCalledWith('sess-1', { id: 'quest-1', pinned });
    expect(res._getJSONData().data.pinned).toBe(pinned);
  });

  it.each(['true', 1, null, {}])('rejects a non-boolean pinned %j before any write', async pinned => {
    const { req, res } = fire({ method: 'PUT', body: { pinned } });

    await expect(handler(req, res)).rejects.toBeDefined();
    expect(mockQuestUpdate).not.toHaveBeenCalled();
  });

  it('writes the pin alongside a reply edit in the same request', async () => {
    const { req, res } = fire({ method: 'PUT', body: { pinned: true, reply: 'edited' } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockQuestUpdate).toHaveBeenCalledWith('sess-1', { id: 'quest-1', reply: 'edited', pinned: true });
  });
});

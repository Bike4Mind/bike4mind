import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// The real baseApi() returns a next-connect router: .get registers the handler and returns the
// SAME router, which is then invoked as `handler(req, res)` and dispatches on req.method. Mocked
// to that shape rather than a bare `(fn) => fn`, which breaks the chain.
vi.mock('@server/middlewares/baseApi', () => {
  function createRouter() {
    const handlers: Record<string, any> = {};
    const router: any = (req: any, res: any) => handlers[req.method?.toUpperCase()](req, res);
    router.get = (fn: any) => {
      handlers.GET = fn;
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
const mockFindCorrectionLinks = vi.fn();
const mockQuestFindById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  sessionRepository: { findById: (...a: any[]) => mockSessionFindById(...a) },
  questRepository: {
    findCorrectionLinksBySessionId: (...a: any[]) => mockFindCorrectionLinks(...a),
    findById: (...a: any[]) => mockQuestFindById(...a),
  },
}));

// buildCorrectionPairs is deliberately NOT mocked: what this route contributes over the service is
// the wiring, so the assertions run the real walk over seeded repository reads.
import handler from '@pages/api/sessions/[id]/correction-pairs';

const OWNER = 'jwt-user';

// `noId`/`anonymous` rather than `id: undefined`, because a destructuring default would put the
// happy-path value back and quietly turn the 400/401 cases into owner requests.
function fire(opts: { noId?: boolean; anonymous?: boolean } = {}) {
  const { req, res } = createMocks({ method: 'GET', query: opts.noId ? {} : { id: 'sess-1' } });
  if (!opts.anonymous) {
    (req as any).user = { id: OWNER };
  }
  return { req: req as any, res: res as any };
}

// A<-B<-C: the root A carries no correctsQuestId, so only B and C come back as links.
const questA = { id: 'quest-a', sessionId: 'sess-1', prompt: 'first ask', reply: 'first answer' };
const questB = {
  id: 'quest-b',
  sessionId: 'sess-1',
  correctsQuestId: 'quest-a',
  prompt: 'no, it was Tuesday',
  reply: 'second answer',
};
const questC = {
  id: 'quest-c',
  sessionId: 'sess-1',
  correctsQuestId: 'quest-b',
  prompt: 'still wrong, it was Wednesday',
  reply: 'third answer',
};

describe('GET /api/sessions/[id]/correction-pairs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: OWNER, users: [] });
    mockFindCorrectionLinks.mockResolvedValue([questB, questC]);
    mockQuestFindById.mockImplementation(async (id: string) => (id === 'quest-a' ? questA : null));
  });

  it('returns one triple per hop, oldest first, for the session owner', async () => {
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockFindCorrectionLinks).toHaveBeenCalledWith('sess-1');
    expect(res._getJSONData().pairs).toMatchObject([
      {
        correctedQuestId: 'quest-a',
        originalAnswer: 'first answer',
        critique: 'no, it was Tuesday',
        correctedAnswer: 'second answer',
      },
      {
        correctedQuestId: 'quest-b',
        originalAnswer: 'second answer',
        critique: 'still wrong, it was Wednesday',
        correctedAnswer: 'third answer',
      },
    ]);
  });

  it('emits prose only - no promptMeta or toolResults reach the response', async () => {
    mockQuestFindById.mockImplementation(async (id: string) =>
      id === 'quest-a'
        ? {
            ...questA,
            promptMeta: { functionCalls: [{ returnValue: 'PRIVATE TOOL OUTPUT' }] },
            toolResults: ['SECRET'],
          }
        : null
    );
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.stringify(res._getJSONData())).not.toContain('PRIVATE TOOL OUTPUT');
    expect(JSON.stringify(res._getJSONData())).not.toContain('SECRET');
  });

  it('404s a non-owner with the same body as a missing session, so status is not an existence oracle', async () => {
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'someone-else', users: [{ userId: OWNER }] });
    const shared = fire();
    await handler(shared.req, shared.res);

    mockSessionFindById.mockResolvedValue(null);
    const missing = fire();
    await handler(missing.req, missing.res);

    expect(shared.res._getStatusCode()).toBe(404);
    expect(missing.res._getStatusCode()).toBe(404);
    expect(shared.res._getJSONData()).toEqual(missing.res._getJSONData());
    expect(mockFindCorrectionLinks).not.toHaveBeenCalled();
  });

  it('404s a session whose only owner field is absent', async () => {
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', users: [] });
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(404);
  });

  it('drops a hop whose corrected turn lives in another session', async () => {
    mockFindCorrectionLinks.mockResolvedValue([questB]);
    mockQuestFindById.mockImplementation(async (id: string) =>
      id === 'quest-a' ? { ...questA, sessionId: 'sess-other' } : null
    );
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().pairs).toEqual([]);
  });

  it('drops a hop whose corrected turn was soft-deleted', async () => {
    mockFindCorrectionLinks.mockResolvedValue([questB]);
    mockQuestFindById.mockImplementation(async (id: string) =>
      id === 'quest-a' ? { ...questA, deletedAt: new Date() } : null
    );
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().pairs).toEqual([]);
  });

  it('returns an empty export, not a 404, for a session with no corrections', async () => {
    mockFindCorrectionLinks.mockResolvedValue([]);
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ pairs: [] });
  });

  it('401s an unauthenticated caller before any session read', async () => {
    const { req, res } = fire({ anonymous: true });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(401);
    expect(mockSessionFindById).not.toHaveBeenCalled();
  });

  it('400s a request with no session id', async () => {
    const { req, res } = fire({ noId: true });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(mockSessionFindById).not.toHaveBeenCalled();
  });
});

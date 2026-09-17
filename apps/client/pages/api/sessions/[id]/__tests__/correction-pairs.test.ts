import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Hoisted: vi.mock's factory runs before module-scope consts exist.
const { baseApiOptions } = vi.hoisted(() => ({ baseApiOptions: [] as unknown[] }));

// The real baseApi() returns a next-connect router: .get registers the handler and returns the
// SAME router, which is then invoked as `handler(req, res)` and dispatches on req.method. Mocked
// to that shape rather than a bare `(fn) => fn`, which breaks the chain. The options are recorded
// because the mock cannot install them: the auth mode is asserted below instead.
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
  return {
    baseApi: (options: unknown) => {
      baseApiOptions.push(options);
      return createRouter();
    },
  };
});

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: any) => fn,
}));

const mockSessionFindById = vi.fn();
const mockFindCorrectionLinks = vi.fn();
const mockQuestFindBySessionIdAndId = vi.fn();
vi.mock('@bike4mind/database', () => ({
  sessionRepository: { findById: (...a: any[]) => mockSessionFindById(...a) },
  questRepository: {
    findCorrectionLinksBySessionId: (...a: any[]) => mockFindCorrectionLinks(...a),
    findBySessionIdAndId: (...a: any[]) => mockQuestFindBySessionIdAndId(...a),
  },
}));

// buildCorrectionPairs is deliberately NOT mocked: what this route contributes over the service is
// the wiring, so the assertions run the real walk over seeded repository reads.
import handler from '@pages/api/sessions/[id]/correction-pairs';

const OWNER = 'jwt-user';
// Real 24-hex ids: the repository reads short-circuit to null on anything else
// (BaseModel.findById), so a 'quest-a' fixture would exercise a read production never performs.
const SESSION_ID = '65000000000000000000e001';
const QUEST_A = '6500000000000000000000aa';
const QUEST_B = '6500000000000000000000bb';
const QUEST_C = '6500000000000000000000cc';

// `noId`/`anonymous` rather than `id: undefined`, because a destructuring default would put the
// happy-path value back and quietly turn the 400/401 cases into owner requests.
function fire(opts: { noId?: boolean; anonymous?: boolean; id?: string } = {}) {
  const { req, res } = createMocks({
    method: 'GET',
    query: opts.noId ? {} : { id: opts.id ?? SESSION_ID },
  });
  if (!opts.anonymous) {
    (req as any).user = { id: OWNER };
  }
  return { req: req as any, res: res as any };
}

// A<-B<-C: the root A carries no correctsQuestId, so only B and C come back as links.
const questA = { id: QUEST_A, sessionId: SESSION_ID, prompt: 'first ask', reply: 'first answer' };
const questB = {
  id: QUEST_B,
  sessionId: SESSION_ID,
  correctsQuestId: QUEST_A,
  prompt: 'no, it was Tuesday',
  reply: 'second answer',
};
const questC = {
  id: QUEST_C,
  sessionId: SESSION_ID,
  correctsQuestId: QUEST_B,
  prompt: 'still wrong, it was Wednesday',
  reply: 'third answer',
};

describe('GET /api/sessions/[id]/correction-pairs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionFindById.mockResolvedValue({ id: SESSION_ID, userId: OWNER, users: [] });
    mockFindCorrectionLinks.mockResolvedValue([questB, questC]);
    mockQuestFindBySessionIdAndId.mockImplementation(async (_sessionId: string, id: string) =>
      id === QUEST_A ? questA : null
    );
  });

  // The 401 below is the handler's own narrowing guard; this is what pins the credential chain the
  // route actually ships with. Plain baseApi() would put verbatim prompts on the API-key surface.
  it('installs the jwt-only credential chain, not the api-key one', () => {
    expect(baseApiOptions).toContainEqual({ auth: 'jwtOnly' });
  });

  it('returns one triple per hop, oldest first, for the session owner', async () => {
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockFindCorrectionLinks).toHaveBeenCalledWith(SESSION_ID, expect.any(Number));
    expect(res._getJSONData().pairs).toMatchObject([
      {
        correctedQuestId: QUEST_A,
        originalAnswer: 'first answer',
        critique: 'no, it was Tuesday',
        correctedAnswer: 'second answer',
      },
      {
        correctedQuestId: QUEST_B,
        originalAnswer: 'second answer',
        critique: 'still wrong, it was Wednesday',
        correctedAnswer: 'third answer',
      },
    ]);
  });

  it('reads the chain root scoped to the session, not by bare id', async () => {
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockQuestFindBySessionIdAndId).toHaveBeenCalledWith(SESSION_ID, QUEST_A);
  });

  // The session's own id, not the raw query string: findById resolves the id through the ObjectId
  // cast, so an uppercase-hex id would otherwise be string-matched against quests and find none.
  it('queries quests with the session record id, not the id as typed', async () => {
    const { req, res } = fire({ id: SESSION_ID.toUpperCase() });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockFindCorrectionLinks).toHaveBeenCalledWith(SESSION_ID, expect.any(Number));
    expect(res._getJSONData().pairs).toHaveLength(2);
  });

  it('caps the export and says so rather than returning a silently partial list', async () => {
    const link = (n: number) => ({
      id: `${n}`.padStart(24, '0'),
      sessionId: SESSION_ID,
      correctsQuestId: `${n - 1}`.padStart(24, '0'),
      prompt: `critique ${n}`,
      reply: `answer ${n}`,
    });
    const requested = mockFindCorrectionLinks.mock.calls;
    mockFindCorrectionLinks.mockImplementation(async (_id: string, limit: number) =>
      Array.from({ length: limit }, (_, i) => link(i + 1))
    );
    mockQuestFindBySessionIdAndId.mockResolvedValue(null);

    const { req, res } = fire();
    await handler(req, res);

    const limit = requested[0][1];
    expect(limit).toBeGreaterThan(1);
    expect(res._getJSONData().truncated).toBe(true);
    expect(res._getJSONData().pairs.length).toBe(limit - 2);
  });

  it('emits prose only - no promptMeta or toolResults reach the response', async () => {
    mockQuestFindBySessionIdAndId.mockImplementation(async (_sessionId: string, id: string) =>
      id === QUEST_A
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
    mockSessionFindById.mockResolvedValue({ id: SESSION_ID, userId: 'someone-else', users: [{ userId: OWNER }] });
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
    mockSessionFindById.mockResolvedValue({ id: SESSION_ID, users: [] });
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(404);
  });

  // What a soft-deleted or foreign chain root actually looks like through the scoped read: the
  // session-bound findOne matches nothing (softDeletePlugin adds `deletedAt: null`), so the hop is
  // dropped for want of a target rather than by a check on the returned document.
  it('drops a hop whose chain root the scoped read cannot see', async () => {
    mockFindCorrectionLinks.mockResolvedValue([questB]);
    mockQuestFindBySessionIdAndId.mockResolvedValue(null);
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
    expect(res._getJSONData()).toEqual({ pairs: [], truncated: false });
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

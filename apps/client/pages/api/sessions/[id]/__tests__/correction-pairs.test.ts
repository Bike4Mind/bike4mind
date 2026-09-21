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
const mockFindCorrectionTurnsByIds = vi.fn();
vi.mock('@bike4mind/database', () => ({
  sessionRepository: { findById: (...a: any[]) => mockSessionFindById(...a) },
  questRepository: {
    findCorrectionLinksBySessionId: (...a: any[]) => mockFindCorrectionLinks(...a),
    findCorrectionTurnsByIds: (...a: any[]) => mockFindCorrectionTurnsByIds(...a),
  },
}));

// buildCorrectionPairs is deliberately NOT mocked: what this route contributes over the service is
// the wiring, so the assertions run the real walk over seeded repository reads.
import handler, { MAX_EXPORTED_LINKS, MAX_EXPORTED_BYTES } from '@pages/api/sessions/[id]/correction-pairs';

const OWNER = 'jwt-user';
// Real 24-hex ids: the repository reads short-circuit to null on anything else
// (BaseModel.findById), so a 'quest-a' fixture would exercise a read production never performs.
const SESSION_ID = '65000000000000000000e001';
const QUEST_A = '6500000000000000000000aa';
const QUEST_B = '6500000000000000000000bb';
const QUEST_C = '6500000000000000000000cc';
const QUEST_D = '6500000000000000000000dd';

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
    mockFindCorrectionTurnsByIds.mockImplementation(async (_sessionId: string, ids: string[]) =>
      ids.includes(QUEST_A) ? [questA] : []
    );
  });

  // The 401 below is the handler's own narrowing guard; this is what pins the credential chain the
  // route actually ships with. Plain baseApi() would put verbatim prompts on the API-key surface.
  it('installs the jwt-only credential chain, not the api-key one', () => {
    expect(baseApiOptions).toContainEqual({ auth: 'jwtOnly' });
  });

  it('returns one triple per hop, oldest first, for the session owner, and reports it complete', async () => {
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockFindCorrectionLinks).toHaveBeenCalledWith(SESSION_ID, expect.any(Number));
    const body = res._getJSONData();
    expect(body.truncated).toBe(false);
    expect(body.pairs).toMatchObject([
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

  it('reads the chain roots scoped to the session, batched in one call', async () => {
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockFindCorrectionTurnsByIds).toHaveBeenCalledWith(SESSION_ID, [QUEST_A]);
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

  it('caps the export at the real MAX_EXPORTED_LINKS value and says so', async () => {
    const link = (n: number) => ({
      id: `${n}`.padStart(24, '0'),
      sessionId: SESSION_ID,
      correctsQuestId: `${n - 1}`.padStart(24, '0'),
      prompt: `critique ${n}`,
      reply: `answer ${n}`,
    });
    mockFindCorrectionLinks.mockImplementation(async (_id: string, limit: number) =>
      Array.from({ length: limit }, (_, i) => link(i + 1))
    );
    mockFindCorrectionTurnsByIds.mockResolvedValue([]);

    const { req, res } = fire();
    await handler(req, res);

    // Pinned against the literal cap, not "limit - 2": that assertion held for any cap >= 1 and
    // proved nothing about MAX_EXPORTED_LINKS itself.
    expect(mockFindCorrectionLinks).toHaveBeenCalledWith(SESSION_ID, MAX_EXPORTED_LINKS + 1);
    const body = res._getJSONData();
    expect(body.truncated).toBe(true);
    // Only the oldest link's root (id "0") is unresolvable; every other hop chains to a link
    // already in the batch, so exactly one hop is dropped off the capped set of MAX_EXPORTED_LINKS.
    expect(body.pairs.length).toBe(MAX_EXPORTED_LINKS - 1);
  });

  it('sets truncated when the byte budget - not the hop cap - is what stops the export', async () => {
    // Far below MAX_EXPORTED_LINKS (3 hops), so truncation here can only come from the byte
    // budget. Each turn's prompt/reply is ~300KB; each pair strings together an original answer,
    // a critique, and a corrected answer, so two pairs stay under MAX_EXPORTED_BYTES and a third
    // does not.
    const BIG = 'x'.repeat(300_000);
    const bigA = { id: QUEST_A, sessionId: SESSION_ID, prompt: 'root', reply: BIG };
    const bigB = { id: QUEST_B, sessionId: SESSION_ID, correctsQuestId: QUEST_A, prompt: BIG, reply: BIG };
    const bigC = { id: QUEST_C, sessionId: SESSION_ID, correctsQuestId: QUEST_B, prompt: BIG, reply: BIG };
    const bigD = { id: QUEST_D, sessionId: SESSION_ID, correctsQuestId: QUEST_C, prompt: BIG, reply: BIG };
    mockFindCorrectionLinks.mockResolvedValue([bigB, bigC, bigD]);
    mockFindCorrectionTurnsByIds.mockImplementation(async (_sessionId: string, ids: string[]) =>
      ids.includes(QUEST_A) ? [bigA] : []
    );

    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.truncated).toBe(true);
    // A prefix, not all three possible hops and not zero.
    expect(body.pairs.length).toBeGreaterThan(0);
    expect(body.pairs.length).toBeLessThan(3);
    expect(MAX_EXPORTED_BYTES).toBeGreaterThan(0);
  });

  it('emits prose only - no promptMeta or toolResults reach the response', async () => {
    mockFindCorrectionTurnsByIds.mockImplementation(async (_sessionId: string, ids: string[]) =>
      ids.includes(QUEST_A)
        ? [
            {
              ...questA,
              promptMeta: { functionCalls: [{ returnValue: 'PRIVATE TOOL OUTPUT' }] },
              toolResults: ['SECRET'],
            },
          ]
        : []
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
  // session-bound batch read matches nothing (softDeletePlugin excludes it), so the hop is dropped
  // for want of a target rather than by a check on the returned document.
  it('drops a hop whose chain root the scoped read cannot see', async () => {
    mockFindCorrectionLinks.mockResolvedValue([questB]);
    mockFindCorrectionTurnsByIds.mockResolvedValue([]);
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

  // F1: the handler's only failure mode is a repository read rejecting. Nothing here mocks
  // asyncHandler as anything but identity, so a thrown rejection must surface, not collapse into
  // a 200 with an empty (or partial) pairs list.
  it('surfaces a rejection from the correction-link read rather than swallowing it into a 200', async () => {
    mockFindCorrectionLinks.mockRejectedValue(new Error('link read failed'));
    const { req, res } = fire();

    await expect(handler(req, res)).rejects.toThrow('link read failed');
  });

  it('surfaces a rejection from the session lookup rather than a 404', async () => {
    mockSessionFindById.mockRejectedValue(new Error('session lookup failed'));
    const { req, res } = fire();

    await expect(handler(req, res)).rejects.toThrow('session lookup failed');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pins the "start chat with this lake" wiring in POST /api/sessions/create: when the request names
 * a lake, the handler access-gates it and seeds the session from the REAL resolveLakeSessionDefaults
 * (used here on purpose, only the gate + createSession are stubbed), with explicit request values
 * winning over the lake defaults. Without a lake, the resolver path must not run at all.
 */
const h = vi.hoisted(() => ({
  createSession: vi.fn(),
  assertLakeAccess: vi.fn(),
  toAccessContext: vi.fn(),
  findByIdAndUpdate: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  projectRepository: {},
  sessionRepository: {},
  fabFileRepository: {},
  userRepository: {},
  activityRepository: {},
  User: { findByIdAndUpdate: h.findByIdAndUpdate },
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: h.logEvent }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@client/config/activities', () => ({ ActivityType: { NOTEBOOK_ADDED_TO_PROJECT: 'added' } }));
vi.mock('@bike4mind/services', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return {
    sessionService: {
      createSession: h.createSession,
      // REAL resolver - the point is the wiring + precedence, not a re-mock of the mapping.
      resolveLakeSessionDefaults: actual.sessionService.resolveLakeSessionDefaults,
    },
    dataLakeService: { assertLakeAccess: h.assertLakeAccess },
    projectService: { get: vi.fn() },
  };
});

import handler from '../create';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const post = (body: Record<string, unknown>) => ({ method: 'POST', user: { id: 'u1' }, ability: {}, body }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

const paramsOf = () => h.createSession.mock.calls[0][1] as Record<string, unknown>;

describe('POST /api/sessions/create - lake-derived session defaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createSession.mockResolvedValue({ id: 's1', name: 'New Notebook', knowledgeIds: [], agentIds: [] });
    h.findByIdAndUpdate.mockResolvedValue(undefined);
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, userTags: [] });
  });

  it('seeds the session from the lake when dataLakeId is given', async () => {
    h.assertLakeAccess.mockResolvedValue({ datalakeTag: 'datalake:acme', preferredSystemPromptId: 'triage_router' });
    const { res } = makeRes();

    await run(post({ name: 'New Notebook', dataLakeId: 'acme' }), res);

    expect(h.assertLakeAccess).toHaveBeenCalledWith('acme', expect.anything(), expect.anything());
    expect(paramsOf()).toMatchObject({
      name: 'New Notebook',
      forceKnowledgeRetrieval: true,
      retrievalTags: ['datalake:acme'],
      systemPromptId: 'triage_router',
    });
  });

  it('lets an explicit request systemPromptId/retrievalTags win over the lake defaults', async () => {
    h.assertLakeAccess.mockResolvedValue({ datalakeTag: 'datalake:acme', preferredSystemPromptId: 'triage_router' });
    const { res } = makeRes();

    await run(
      post({ name: 'N', dataLakeId: 'acme', systemPromptId: 'user_choice', retrievalTags: ['mock:breast'] }),
      res
    );

    const params = paramsOf();
    expect(params.systemPromptId).toBe('user_choice');
    expect(params.retrievalTags).toEqual(['mock:breast']);
  });

  it('does not run the lake path (no access gate) when no dataLakeId is given', async () => {
    const { res } = makeRes();

    await run(post({ name: 'Plain' }), res);

    expect(h.assertLakeAccess).not.toHaveBeenCalled();
    expect(h.toAccessContext).not.toHaveBeenCalled();
    const params = paramsOf();
    expect('systemPromptId' in params).toBe(false);
    expect('forceKnowledgeRetrieval' in params).toBe(false);
  });
});

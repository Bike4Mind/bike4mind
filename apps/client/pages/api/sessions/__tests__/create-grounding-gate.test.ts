import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * corpusGroundingMode is resolved server-side and must never let a hand-built request pin a mode
 * the server did not choose - except the one case where naming a lake BY TAGS (retrievalTags, no
 * dataLakeId) is itself the caller's deliberate act of choosing what to test, and there is no later
 * lake-defaults merge for a client value to override.
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
  dataLakeAccessGrantRepository: {
    listByLake: vi.fn().mockResolvedValue([]),
    listActiveByLakes: vi.fn().mockResolvedValue([]),
    listByPrincipal: vi.fn().mockResolvedValue([]),
    findGrant: vi.fn().mockResolvedValue(null),
    upsertGrant: vi.fn().mockResolvedValue({}),
    removeGrant: vi.fn().mockResolvedValue(true),
    removeAllForLake: vi.fn().mockResolvedValue(0),
  },
  organizationRepository: { findIdsWithAdminRights: vi.fn().mockResolvedValue([]) },
  projectRepository: {},
  agentRepository: {},
  sessionRepository: {},
  fabFileRepository: {},
  fallbackLakeSettingsRepository: {},
  userRepository: {},
  activityRepository: {},
  User: { findByIdAndUpdate: h.findByIdAndUpdate },
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: h.logEvent }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@client/config/activities', () => ({ ActivityType: { NOTEBOOK_ADDED_TO_PROJECT: 'added' } }));
vi.mock('@bike4mind/services', () => ({
  sessionService: {
    createSession: h.createSession,
    resolveLakeSessionDefaults: (lake: { datalakeTag: string; groundingMode?: string }) => ({
      retrievalTags: [lake.datalakeTag],
      corpusGroundingMode: lake.groundingMode,
    }),
  },
  dataLakeService: { assertLakeAccess: h.assertLakeAccess, resolveCanManageLake: vi.fn() },
  projectService: { get: vi.fn() },
}));

import handler from '../create';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const post = (body: Record<string, unknown>) => ({ method: 'POST', user: { id: 'u1' }, ability: {}, body }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
const paramsOf = () => h.createSession.mock.calls[0][1] as Record<string, unknown>;

describe('POST /api/sessions/create - corpusGroundingMode gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createSession.mockResolvedValue({ id: 's1', name: 'New Notebook', knowledgeIds: [], agentIds: [] });
    h.findByIdAndUpdate.mockResolvedValue(undefined);
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, userTags: [] });
  });

  it('strips a client-sent mode on an ordinary session (no retrievalTags, no dataLakeId)', async () => {
    const { res } = makeRes();

    await run(post({ name: 'N', corpusGroundingMode: 'inline' }), res);

    expect('corpusGroundingMode' in paramsOf()).toBe(false);
  });

  it('keeps a client-sent mode when the session names a lake only by retrievalTags', async () => {
    const { res } = makeRes();

    await run(post({ name: 'N', retrievalTags: ['datalake:acme'], corpusGroundingMode: 'inline' }), res);

    expect(paramsOf().corpusGroundingMode).toBe('inline');
    expect(h.assertLakeAccess).not.toHaveBeenCalled();
  });

  it('strips a client-sent mode when retrievalTags is present but empty', async () => {
    const { res } = makeRes();

    await run(post({ name: 'N', retrievalTags: [], corpusGroundingMode: 'inline' }), res);

    // An empty array names no lake, so it belongs on the ordinary-session branch rather than the
    // tags-only exception that trusts the caller's mode.
    expect('corpusGroundingMode' in paramsOf()).toBe(false);
  });

  it('strips a client-sent mode when dataLakeId is set, even alongside retrievalTags, so the lake wins', async () => {
    h.assertLakeAccess.mockResolvedValue({ datalakeTag: 'datalake:acme', groundingMode: 'inline' });
    const { res } = makeRes();

    await run(
      post({ name: 'N', dataLakeId: 'acme', retrievalTags: ['mock:tag'], corpusGroundingMode: 'retrieve' }),
      res
    );

    // The lake's own mode, not the client-sent 'retrieve' - proves the client value never reached
    // the merge rather than merely losing a tie against an identical lake default.
    expect(paramsOf().corpusGroundingMode).toBe('inline');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * summaryTrigger is copy metadata: the summarization handler stamps it, and fork/snip/clone carry
 * it from a source. createSessionParametersSchema has to declare it for those copy paths, and this
 * route passes a raw, unparsed body straight into createSession - so without the strip in the
 * handler a caller could persist trusted-looking provenance on a notebook nothing ever summarized.
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
  dataLakeAccessGrantRepository: {},
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
    resolveLakeSessionDefaults: (lake: { datalakeTag: string }) => ({ retrievalTags: [lake.datalakeTag] }),
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

describe('POST /api/sessions/create - summaryTrigger is never client input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createSession.mockResolvedValue({ id: 's1', name: 'New Notebook', knowledgeIds: [], agentIds: [] });
    h.findByIdAndUpdate.mockResolvedValue(undefined);
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, userTags: [] });
  });

  // The dangerous case is a WELL-FORMED value: an in-enum trigger is what the service schema would
  // happily persist, so the strip - not the enum - is what stops it.
  it('strips a valid in-enum trigger from an ordinary create', async () => {
    const { res } = makeRes();

    await run(post({ name: 'Unsummarized', summaryTrigger: 'project' }), res);

    expect('summaryTrigger' in paramsOf()).toBe(false);
  });

  it('strips throttling, which names a summarization that was declined', async () => {
    const { res } = makeRes();

    await run(post({ name: 'Unsummarized', summaryTrigger: 'throttling' }), res);

    expect('summaryTrigger' in paramsOf()).toBe(false);
  });

  // The lake branch rebuilds the params as { ...lakeDefaults, ...body }, so a strip that ran only on
  // the ordinary branch would leak the field straight back in through that second spread.
  it('strips it on the lake-defaults branch, where the body is spread a second time', async () => {
    h.assertLakeAccess.mockResolvedValue({ datalakeTag: 'datalake:acme' });
    const { res } = makeRes();

    await run(post({ name: 'N', dataLakeId: 'acme', summaryTrigger: 'manual' }), res);

    expect('summaryTrigger' in paramsOf()).toBe(false);
    expect(paramsOf().retrievalTags).toEqual(['datalake:acme']);
  });

  it('leaves an ordinary create untouched when no trigger is sent', async () => {
    const { res } = makeRes();

    await run(post({ name: 'N' }), res);

    expect('summaryTrigger' in paramsOf()).toBe(false);
    expect(paramsOf().name).toBe('N');
  });
});

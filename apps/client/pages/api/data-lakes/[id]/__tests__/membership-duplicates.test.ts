import { describe, it, expect, vi, beforeEach } from 'vitest';

const LAKE = {
  id: 'lake1',
  datalakeTag: 'datalake:org1:acme-docs',
  fileTagPrefix: 'acme:',
  createdByUserId: 'creator-1',
};

const PLAN = {
  open: [{ fileName: 'policy.md', tier: 'fileName', bucket: 'differing', members: [], memberCount: 2 }],
  openGroupCount: 1,
  settledGroupCount: 3,
  stalledGroupCount: 0,
  scope: { kind: 'owned', datalakeTag: LAKE.datalakeTag, fileTagPrefix: 'acme:', creatorUserId: 'creator-1' },
  scanTruncated: false,
};

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeWritable: vi.fn(),
  resolveCanManageLake: vi.fn(async () => true),
  loadMembershipRepairPlan: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'creator-1', isAdmin: false })),
  // A plain array, not a spy: the middleware is applied once when the module is imported, and
  // `vi.clearAllMocks()` in beforeEach would erase that call before any test could assert on it.
  featureFlags: [] as string[],
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled: (flag: string) => {
    h.featureFlags.push(flag);
    return () => {};
  },
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    assertLakeWritable: h.assertLakeWritable,
    resolveCanManageLake: h.resolveCanManageLake,
    loadMembershipRepairPlan: h.loadMembershipRepairPlan,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  fabFileRepository: {},
  lakeMembershipDecisionRepository: {},
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../membership-duplicates';

const invoke = (req: unknown, res: unknown) =>
  (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);

const makeReq = () => ({
  method: 'GET',
  query: { id: 'lake1' },
  user: { id: 'creator-1' },
  logger: { warn: vi.fn(), error: vi.fn() },
});
const makeRes = () => {
  const res = { json: vi.fn(() => res) };
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks resets calls, NOT implementations - the built-in-lake test installs a throwing
  // one, and without this it leaks into every test that follows.
  h.assertLakeWritable.mockImplementation(() => undefined);
  h.assertLakeAccess.mockResolvedValue(LAKE);
  h.resolveCanManageLake.mockResolvedValue(true);
  h.loadMembershipRepairPlan.mockResolvedValue(PLAN);
});

describe('GET /api/data-lakes/[id]/membership-duplicates', () => {
  it('returns the plan for a manager', async () => {
    const res = makeRes();

    await invoke(makeReq(), res);

    expect(h.loadMembershipRepairPlan).toHaveBeenCalledWith(
      LAKE,
      expect.objectContaining({
        db: expect.objectContaining({ fabFiles: {}, lakeMembershipDecisions: {} }),
      })
    );
    expect(res.json).toHaveBeenCalledWith(PLAN);
  });

  it('refuses a principal who can read the lake but not manage it', async () => {
    // Matches the gate on the POST that answers these groups: what is open to decide names the
    // copies a manager is about to remove.
    h.resolveCanManageLake.mockResolvedValue(false);
    const res = makeRes();

    await expect(invoke(makeReq(), res)).rejects.toThrow('You do not have permission to resolve duplicates');
    expect(h.loadMembershipRepairPlan).not.toHaveBeenCalled();
  });

  it('refuses a built-in lake, so no unanswerable question is offered', async () => {
    h.assertLakeWritable.mockImplementation(() => {
      throw new Error('This data lake is built in and cannot be modified');
    });
    const res = makeRes();

    await expect(invoke(makeReq(), res)).rejects.toThrow('built in');
    expect(h.loadMembershipRepairPlan).not.toHaveBeenCalled();
  });

  it('resolves access before anything else, so a stranger cannot probe the lake', async () => {
    h.assertLakeAccess.mockRejectedValue(new Error('Data lake not found'));
    const res = makeRes();

    await expect(invoke(makeReq(), res)).rejects.toThrow('not found');
    expect(h.resolveCanManageLake).not.toHaveBeenCalled();
    expect(h.loadMembershipRepairPlan).not.toHaveBeenCalled();
  });

  it('is gated on the data-lakes feature flag', () => {
    expect(h.featureFlags).toContain('EnableDataLakes');
  });
});

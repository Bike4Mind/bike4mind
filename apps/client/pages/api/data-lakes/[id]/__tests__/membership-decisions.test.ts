import { describe, it, expect, vi, beforeEach } from 'vitest';

const LAKE = {
  id: 'lake1',
  datalakeTag: 'datalake:org1:acme-docs',
  fileTagPrefix: 'acme:',
  createdByUserId: 'creator-1',
};

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeWritable: vi.fn(),
  resolveCanManageLake: vi.fn(async () => true),
  applyAdmissionDecision: vi.fn(async () => ({
    group: { fileName: 'policy.md', tier: 'fileName', bucket: 'differing', members: [], memberCount: 2 },
    removedFabFileIds: ['old-1'],
  })),
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
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
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
    applyAdmissionDecision: h.applyAdmissionDecision,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  fabFileRepository: {},
  lakeMembershipDecisionRepository: {},
  lakeMembershipRemovalRepository: {},
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/dataLakes/lakeConfigAuditDb', () => ({ lakeConfigAuditDb: { dataLakeConfigChanges: {} } }));
vi.mock('@server/dataLakes/lakeConfigAuditPrincipal', () => ({
  lakeConfigAuditPrincipal: () => ({ kind: 'user', userId: 'creator-1' }),
}));

import handler from '../membership-decisions';

const invoke = (req: unknown, res: unknown) =>
  (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);

const makeReq = (body: unknown) => ({
  method: 'POST',
  query: { id: 'lake1' },
  body,
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
  // one, which otherwise leaks into every test declared after it.
  h.assertLakeWritable.mockImplementation(() => undefined);
  h.assertLakeAccess.mockResolvedValue(LAKE);
  h.resolveCanManageLake.mockResolvedValue(true);
  h.applyAdmissionDecision.mockResolvedValue({
    group: { fileName: 'policy.md', tier: 'fileName', bucket: 'differing', members: [], memberCount: 2 },
    removedFabFileIds: ['old-1'],
  });
});

describe('POST /api/data-lakes/:id/membership-decisions', () => {
  it('applies a keep-newest ruling and reports what it removed', async () => {
    const res = makeRes();

    await invoke(makeReq({ fileName: 'policy.md', decision: 'keep-newest' }), res);

    expect(h.applyAdmissionDecision).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'creator-1' }),
      LAKE,
      { fileName: 'policy.md', decision: 'keep-newest', keptFabFileId: null },
      expect.anything()
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, decision: 'keep-newest', removedFabFileIds: ['old-1'] })
    );
  });

  it('applies a keep-both ruling, which writes the tombstone and removes nothing', async () => {
    h.applyAdmissionDecision.mockResolvedValue({
      group: { fileName: 'policy.md', tier: 'relativePath', bucket: 'differing', members: [], memberCount: 2 },
      removedFabFileIds: [],
    });
    const res = makeRes();

    await invoke(makeReq({ fileName: 'policy.md', decision: 'keep-both' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'keep-both', removedFabFileIds: [], tier: 'relativePath' })
    );
  });

  it('passes keep-specific through with the member the owner chose', async () => {
    const res = makeRes();

    await invoke(makeReq({ fileName: 'policy.md', decision: 'keep-specific', keptFabFileId: 'old-1' }), res);

    expect(h.applyAdmissionDecision).toHaveBeenCalledWith(
      expect.anything(),
      LAKE,
      { fileName: 'policy.md', decision: 'keep-specific', keptFabFileId: 'old-1' },
      expect.anything()
    );
  });

  it('MANAGE-gates the write - a reader who can see the lake cannot resolve its duplicates', async () => {
    // The read gate admits org/tag/public readers; this door removes membership, so it needs the
    // same rung the add and remove doors apply.
    h.resolveCanManageLake.mockResolvedValue(false);

    await expect(invoke(makeReq({ fileName: 'policy.md', decision: 'keep-newest' }), makeRes())).rejects.toThrow(
      'do not have permission'
    );
    expect(h.applyAdmissionDecision).not.toHaveBeenCalled();
  });

  it('refuses a built-in lake before touching membership', async () => {
    h.assertLakeWritable.mockImplementation(() => {
      throw new Error('This data lake is built in and cannot be modified');
    });

    await expect(invoke(makeReq({ fileName: 'policy.md', decision: 'keep-newest' }), makeRes())).rejects.toThrow(
      'built in'
    );
    expect(h.applyAdmissionDecision).not.toHaveBeenCalled();
  });

  it('rejects a keep-specific with no member to keep', async () => {
    await expect(invoke(makeReq({ fileName: 'policy.md', decision: 'keep-specific' }), makeRes())).rejects.toThrow(
      'keptFabFileId is required'
    );
    expect(h.applyAdmissionDecision).not.toHaveBeenCalled();
  });

  it('rejects a keptFabFileId on a decision that cannot use one', async () => {
    // Stored, it would read as the owner's choice to every surface while removing nothing.
    await expect(
      invoke(makeReq({ fileName: 'policy.md', decision: 'keep-both', keptFabFileId: 'old-1' }), makeRes())
    ).rejects.toThrow('keptFabFileId');
    expect(h.applyAdmissionDecision).not.toHaveBeenCalled();
  });

  it('rejects a decision outside the shared repair vocabulary', async () => {
    // One vocabulary with the repair plan: a value the planner cannot act on must never persist.
    await expect(invoke(makeReq({ fileName: 'policy.md', decision: 'replace' }), makeRes())).rejects.toThrow();
    expect(h.applyAdmissionDecision).not.toHaveBeenCalled();
  });

  it('rejects an empty file name rather than reading the whole lake', async () => {
    await expect(invoke(makeReq({ fileName: '', decision: 'keep-newest' }), makeRes())).rejects.toThrow();
    expect(h.applyAdmissionDecision).not.toHaveBeenCalled();
  });

  it('validates the body BEFORE resolving the lake, so a bad body cannot probe existence', async () => {
    await expect(invoke(makeReq({}), makeRes())).rejects.toThrow();
    expect(h.assertLakeAccess).not.toHaveBeenCalled();
  });

  it('is gated on the data-lakes feature flag', () => {
    expect(h.featureFlags).toContain('EnableDataLakes');
  });
});

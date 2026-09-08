import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeWritable: vi.fn(),
  setLakeVisibility: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false, administeredOrgIds: ['org-1'] })),
  resolveActiveOrg: vi.fn(async () => 'org-1'),
}));

// baseApi mock: callable chain routed by req.method (same shape as the sibling endpoint tests).
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
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    assertLakeWritable: h.assertLakeWritable,
    setLakeVisibility: h.setLakeVisibility,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: { listByLake: vi.fn().mockResolvedValue([]) },
  // The config-audit repos this route wires (see lakeConfigAuditDb). Stubbed rather than omitted
  // because the mock replaces the whole module: a missing export is an import-time failure, not a
  // silent undefined.
  lakeConfigChangeEventRepository: { record: vi.fn().mockResolvedValue({}) },
  adminSettingsRepository: {
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/utils/resolveActiveOrg', () => ({ resolveActiveOrg: h.resolveActiveOrg }));

import handler from '../visibility';

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) };
  return { res, json };
};

const req = (body: unknown) => ({ method: 'POST', query: { id: 'my-lake' }, body, logger: { warn: vi.fn() } });

const call = (r: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);

describe('POST /api/data-lakes/[id]/visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-1', createdByUserId: 'u1', status: 'active' });
    h.assertLakeWritable.mockReturnValue(undefined);
    h.setLakeVisibility.mockResolvedValue({ id: 'lake-oid-1', isPublic: false, organizationId: 'org-1' });
    h.resolveActiveOrg.mockResolvedValue('org-1');
  });

  /**
   * The reason this file exists. A visibility change is a config write, so it must record an audit
   * event - but every audit adapter reaches the service through one shared `db` literal, and
   * `adminSettings` is deliberately optional (the retention read is best-effort). A route that
   * dropped it would still compile and would silently pin every event on this path to the
   * floor-default retention, which no other check would notice.
   */
  it('wires the config-audit repositories into setLakeVisibility', async () => {
    const { res } = makeRes();
    await call(req({ visibility: 'organization', organizationId: 'org-1' }), res);

    expect(h.setLakeVisibility).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', isAdmin: false }),
      'lake-oid-1',
      'organization',
      expect.objectContaining({
        db: expect.objectContaining({
          lakeConfigChangeEvents: expect.anything(),
          adminSettings: expect.anything(),
        }),
      })
    );
  });

  it('passes the validated active org as the promotion target, not the client-supplied one', async () => {
    h.resolveActiveOrg.mockResolvedValue('org-validated');
    const { res } = makeRes();
    await call(req({ visibility: 'organization', organizationId: 'org-claimed' }), res);

    expect(h.resolveActiveOrg).toHaveBeenCalledWith(expect.anything(), 'org-claimed');
    expect(h.setLakeVisibility).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-validated' }),
      'lake-oid-1',
      'organization',
      expect.anything()
    );
  });

  it('gates on access before writing, so an unreachable lake never reaches the service', async () => {
    h.assertLakeAccess.mockRejectedValue(new Error('Data lake not found'));
    const { res } = makeRes();

    await expect(call(req({ visibility: 'public' }), res)).rejects.toThrow(/not found/i);
    expect(h.setLakeVisibility).not.toHaveBeenCalled();
  });
});

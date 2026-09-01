import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LakeAccessView } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  loadActiveLakeGrants: vi.fn(),
  canManageLake: vi.fn(),
  resolveLakeTransferAuthority: vi.fn(),
  assembleLakeAccessView: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false, administeredOrgIds: [] })),
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
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    loadActiveLakeGrants: h.loadActiveLakeGrants,
    canManageLake: h.canManageLake,
    resolveLakeTransferAuthority: h.resolveLakeTransferAuthority,
    assembleLakeAccessView: h.assembleLakeAccessView,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  lakeAccessEventRepository: {},
  userRepository: {},
  organizationRepository: {},
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../access';

const view: LakeAccessView = {
  lakeId: 'lake-oid-1',
  lakeName: 'Sales Intelligence',
  grants: [
    {
      principalType: 'user',
      principalId: 'u2',
      principalName: 'Bob',
      role: 'reader',
      grantedByUserId: 'u1',
      grantedByName: 'Alice',
      grantedAt: new Date('2026-08-01T00:00:00.000Z'),
      expiresAt: null,
      status: 'active',
    },
  ],
  channels: [{ kind: 'organization', value: 'orgA', label: 'Acme', holderCount: 3 }],
  history: [],
  historyTruncated: false,
  generatedAt: new Date('2026-08-14T12:00:00.000Z'),
};

/** Stands in for the lake's active grants, so a test can assert BOTH decisions saw the same read. */
const GRANTS = [{ principalType: 'user', principalId: 'u1', role: 'owner' }];

const makeRes = () => {
  const json = vi.fn();
  const send = vi.fn();
  const setHeader = vi.fn();
  return { res: { json, send, setHeader, status: vi.fn(() => ({ json, send })) } as never, json, send, setHeader };
};
const req = (query: Record<string, string>) => ({ method: 'GET', query }) as never;
const call = (r: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);

describe('GET /api/data-lakes/[id]/access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, administeredOrgIds: [] });
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-1', name: 'Sales Intelligence' });
    h.loadActiveLakeGrants.mockResolvedValue(GRANTS);
    h.canManageLake.mockReturnValue(true);
    h.resolveLakeTransferAuthority.mockReturnValue({ allowed: false, viaOrgAdminOnly: false });
    h.assembleLakeAccessView.mockResolvedValue(view);
  });

  it('assembles the view against the RESOLVED lake and returns it as JSON', async () => {
    const { res, json } = makeRes();
    await call(req({ id: 'my-lake' }), res);
    // assembleLakeAccessView must get the resolved lake object, not the raw slug.
    expect(h.assembleLakeAccessView).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lake-oid-1' }),
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith({ data: view, meta: { canTransferOwnership: false } });
  });

  it('refuses a caller who can read but not manage the lake (403), without assembling', async () => {
    h.canManageLake.mockReturnValue(false);
    const { res } = makeRes();
    await expect(call(req({ id: 'lake1' }), res)).rejects.toThrow(/manage/i);
    expect(h.assembleLakeAccessView).not.toHaveBeenCalled();
  });

  it('never reaches the manage gate when the lake is not accessible at all', async () => {
    h.assertLakeAccess.mockRejectedValue(new Error('Data lake not found'));
    const { res } = makeRes();
    await expect(call(req({ id: 'lake1' }), res)).rejects.toThrow(/not found/i);
    expect(h.canManageLake).not.toHaveBeenCalled();
  });

  it('streams a CSV attachment when format=csv', async () => {
    const { res, send, setHeader } = makeRes();
    await call(req({ id: 'lake1', format: 'csv' }), res);
    expect(setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
    expect(setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="lake-access-lake-oid-1.csv"');
    const body = send.mock.calls[0][0] as string;
    expect(body).toContain('# Members and grants');
    expect(body).toContain('"user","u2","Bob","reader","active"');
  });

  it('still streams CSV when format is repeated, rather than 500ing on the array (#2095)', async () => {
    // `?format=csv&format=csv` arrives as an array. `(format ?? '').toLowerCase()` threw a TypeError
    // on it - a 500 raised AFTER the manage gate and the whole access aggregation had already run,
    // so the work was done and then thrown away.
    const { res, send, setHeader } = makeRes();
    await call(req({ id: 'lake1', format: ['csv', 'csv'] }), res);
    expect(setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
    expect(send.mock.calls[0][0] as string).toContain('# Members and grants');
  });

  it('applies the identical manage gate to the CSV path (403 before assembling, no attachment)', async () => {
    h.canManageLake.mockReturnValue(false);
    const { res, send, setHeader } = makeRes();
    await expect(call(req({ id: 'lake1', format: 'csv' }), res)).rejects.toThrow(/manage/i);
    expect(h.assembleLakeAccessView).not.toHaveBeenCalled();
    expect(setHeader).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("reports the viewer's transfer capability in meta, leaving the exported view untouched", async () => {
    h.resolveLakeTransferAuthority.mockReturnValue({ allowed: true, viaOrgAdminOnly: false });
    const { res, json } = makeRes();
    await call(req({ id: 'lake1' }), res);
    expect(json).toHaveBeenCalledWith({ data: view, meta: { canTransferOwnership: true } });
    // The capability is per-VIEWER; the artifact must not absorb it, or the CSV would claim it too.
    expect(json.mock.calls[0][0].data).not.toHaveProperty('canTransferOwnership');
  });

  it('decides the manage gate and the transfer capability from ONE grants read', async () => {
    const { res } = makeRes();
    await call(req({ id: 'lake1' }), res);
    expect(h.loadActiveLakeGrants).toHaveBeenCalledTimes(1);
    // Both rules must see the SAME grant set: re-reading could decide the two against different
    // snapshots, and offering a transfer control the write path then refuses is the drift to avoid.
    expect(h.canManageLake).toHaveBeenCalledWith(expect.anything(), expect.anything(), GRANTS);
    expect(h.resolveLakeTransferAuthority).toHaveBeenCalledWith(expect.anything(), expect.anything(), GRANTS);
  });

  it('keeps the per-viewer capability out of the CSV artifact', async () => {
    h.resolveLakeTransferAuthority.mockReturnValue({ allowed: true, viaOrgAdminOnly: false });
    const { res, send } = makeRes();
    await call(req({ id: 'lake1', format: 'csv' }), res);
    expect(send.mock.calls[0][0] as string).not.toContain('canTransferOwnership');
  });
});

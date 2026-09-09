import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  grantLakeAccess: vi.fn(),
  revokeLakeAccess: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false, administeredOrgIds: [] })),
}));

// baseApi mock: callable chain routed by req.method (same shape as the sibling endpoint tests).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    grantLakeAccess: h.grantLakeAccess,
    revokeLakeAccess: h.revokeLakeAccess,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  // The config-audit repos this route wires (see lakeConfigAuditDb). Stubbed rather than omitted
  // because the mock replaces the whole module: a missing export is an import-time failure.
  lakeConfigChangeEventRepository: { record: vi.fn().mockResolvedValue({}) },
  adminSettingsRepository: {
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
  dataLakeAccessGrantRepository: {},
  userRepository: {},
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../grants';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const call = (r: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);

describe('/api/data-lakes/[id]/grants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, administeredOrgIds: [] });
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-1', slug: 'my-lake' });
    h.grantLakeAccess.mockResolvedValue({ principalType: 'user', principalId: 'u2', role: 'reader' });
    h.revokeLakeAccess.mockResolvedValue({ revoked: true });
  });

  it('grants against the RESOLVED lake and wires the audit repos', async () => {
    // assertLakeAccess resolves id-or-slug, so the service must get lake.id, not the raw query value.
    const { res, json } = makeRes();
    await call(
      { method: 'POST', query: { id: 'my-lake' }, body: { principalType: 'user', principalId: 'u2', role: 'reader' } },
      res
    );

    expect(h.grantLakeAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', isAdmin: false }),
      'lake-oid-1',
      expect.objectContaining({ principalType: 'user', principalId: 'u2', role: 'reader' }),
      // Not expect.anything(): the audit repos ride one shared helper, and a route that dropped
      // `adminSettings` would still compile while quietly pinning every event to the floor default.
      expect.objectContaining({
        db: expect.objectContaining({ lakeConfigChangeEvents: expect.anything(), adminSettings: expect.anything() }),
      })
    );
    expect(json).toHaveBeenCalledWith({ data: { principalType: 'user', principalId: 'u2', role: 'reader' } });
  });

  it('coerces an expiry and accepts an email-named principal', async () => {
    const { res } = makeRes();
    await call(
      {
        method: 'POST',
        query: { id: 'lake1' },
        body: { principalType: 'user', principalEmail: 'a@b.co', role: 'reader', expiresAt: '2027-01-01T00:00:00Z' },
      },
      res
    );
    expect(h.grantLakeAccess).toHaveBeenCalledWith(
      expect.anything(),
      'lake-oid-1',
      expect.objectContaining({ principalEmail: 'a@b.co', expiresAt: new Date('2027-01-01T00:00:00Z') }),
      expect.anything()
    );
  });

  it('rejects a body naming neither a role nor a known principal type, before the service', async () => {
    const { res } = makeRes();
    await expect(
      call({ method: 'POST', query: { id: 'lake1' }, body: { principalType: 'group' } }, res)
    ).rejects.toThrow();
    expect(h.grantLakeAccess).not.toHaveBeenCalled();
  });

  it('revokes from the query pair', async () => {
    const { res, json } = makeRes();
    await call({ method: 'DELETE', query: { id: 'my-lake', principalType: 'user', principalId: 'u2' } }, res);

    expect(h.revokeLakeAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      'lake-oid-1',
      { principalType: 'user', principalId: 'u2' },
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith({ data: { revoked: true } });
  });

  it('narrows a repeated query param rather than passing an array through', async () => {
    const { res } = makeRes();
    await call({ method: 'DELETE', query: { id: 'lake1', principalType: ['user', 'user'], principalId: ['u2'] } }, res);
    expect(h.revokeLakeAccess).toHaveBeenCalledWith(
      expect.anything(),
      'lake-oid-1',
      { principalType: 'user', principalId: 'u2' },
      expect.anything()
    );
  });

  it('does not reach the service when the caller cannot see the lake', async () => {
    // assertLakeAccess denies with a not-found-style error, so existence is never disclosed.
    h.assertLakeAccess.mockRejectedValue(new Error('Data lake not found'));
    const { res } = makeRes();
    await expect(
      call(
        { method: 'POST', query: { id: 'lake1' }, body: { principalType: 'user', principalId: 'u2', role: 'reader' } },
        res
      )
    ).rejects.toThrow(/not found/i);
    expect(h.grantLakeAccess).not.toHaveBeenCalled();
  });
});

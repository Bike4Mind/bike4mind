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

  it('grants against the RESOLVED lake, trimming the principal, and wires the audit repos', async () => {
    // assertLakeAccess resolves id-or-slug, so the service must get lake.id, not the raw query value.
    const { res, json } = makeRes();
    await call(
      {
        method: 'POST',
        query: { id: 'my-lake' },
        // Trimmed at the boundary: this string is half of a grant's natural key, so a padded
        // variant would address a second row for the same principal that no read could match.
        body: { principalType: 'organization', principalId: ' org1 ', role: 'reader' },
      },
      res
    );

    expect(h.grantLakeAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', isAdmin: false }),
      'lake-oid-1',
      expect.objectContaining({ principalType: 'organization', principalId: 'org1', role: 'reader' }),
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

  it('revokes from the query pair, and wires the audit repos', async () => {
    const { res, json } = makeRes();
    await call({ method: 'DELETE', query: { id: 'my-lake', principalType: 'user', principalId: 'u2' } }, res);

    expect(h.revokeLakeAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      'lake-oid-1',
      { principalType: 'user', principalId: 'u2' },
      // Pinned on THIS door too, not just the grant one: revoking is the single most audit-relevant
      // write on a lake, and dropping the shared helper here compiles and leaves every other suite
      // green while the event goes unrecorded. Service-level tests cannot see route wiring.
      expect.objectContaining({
        db: expect.objectContaining({ lakeConfigChangeEvents: expect.anything(), adminSettings: expect.anything() }),
      })
    );
    expect(json).toHaveBeenCalledWith({ data: { revoked: true } });
  });

  it('narrows a repeated query param rather than passing an array through', async () => {
    const { res } = makeRes();
    await call(
      { method: 'DELETE', query: { id: 'lake1', principalType: ['user', 'user'], principalId: [' u2 '] } },
      res
    );
    expect(h.revokeLakeAccess).toHaveBeenCalledWith(
      expect.anything(),
      'lake-oid-1',
      { principalType: 'user', principalId: 'u2' },
      expect.anything()
    );
  });

  /**
   * API-key attribution, asserted at the ROUTE because that is the only place it exists: the actor
   * is built here and `lakeConfigAuditPrincipal` is not mocked, so this exercises the real helper.
   *
   * Silent failure mode: delete the `auditPrincipal` line from either handler and every other suite
   * stays green while key-driven ACCESS changes - the most audit-relevant write on a lake - are
   * recorded as the owning human's own edit, permanently, in append-only rows.
   */
  it.each([
    {
      door: 'POST',
      req: {
        method: 'POST',
        query: { id: 'lake1' },
        body: { principalType: 'user', principalEmail: 'a@b.co', role: 'reader' },
      },
      service: () => h.grantLakeAccess,
    },
    {
      door: 'DELETE',
      req: { method: 'DELETE', query: { id: 'lake1', principalType: 'user', principalId: 'u2' } },
      service: () => h.revokeLakeAccess,
    },
  ])('$door attaches the KEY as the audit principal for an API-key caller', async ({ req, service }) => {
    const { res } = makeRes();
    await call({ ...req, user: { id: 'u1' }, apiKeyInfo: { keyId: 'key-abc' } }, res);
    expect(service()).toHaveBeenCalledWith(
      expect.objectContaining({
        auditPrincipal: { principalKind: 'apiKey', principalId: 'key-abc', onBehalfOfUserId: 'u1' },
      }),
      'lake-oid-1',
      expect.anything(),
      expect.anything()
    );
  });

  it('attaches NO audit principal for a session write, leaving the service derivation alone', async () => {
    const { res } = makeRes();
    await call(
      {
        method: 'POST',
        query: { id: 'lake1' },
        body: { principalType: 'user', principalEmail: 'a@b.co', role: 'reader' },
        user: { id: 'u1' },
        apiKeyInfo: undefined,
      },
      res
    );
    const actor = h.grantLakeAccess.mock.calls[0][0] as { auditPrincipal?: unknown };
    expect(actor.auditPrincipal).toBeUndefined();
  });

  it('does not reach the service when the caller cannot see the lake', async () => {
    // assertLakeAccess denies with a not-found-style error, so existence is never disclosed.
    h.assertLakeAccess.mockRejectedValue(new Error('Data lake not found'));
    const { res } = makeRes();
    await expect(
      call(
        {
          method: 'POST',
          query: { id: 'lake1' },
          body: { principalType: 'user', principalEmail: 'a@b.co', role: 'reader' },
        },
        res
      )
    ).rejects.toThrow(/not found/i);
    expect(h.grantLakeAccess).not.toHaveBeenCalled();
  });
});

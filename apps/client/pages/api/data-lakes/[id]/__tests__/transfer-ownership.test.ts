import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  transferLakeOwnership: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false, administeredOrgIds: [] })),
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
  dataLakeService: { assertLakeAccess: h.assertLakeAccess, transferLakeOwnership: h.transferLakeOwnership },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  // The config-audit repos this route wires (see lakeConfigAuditDb). Stubbed rather than
  // omitted because the mock replaces the whole module: a missing export is an import-time
  // failure, not a silent undefined.
  lakeConfigChangeEventRepository: { record: vi.fn().mockResolvedValue({}) },
  adminSettingsRepository: {
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
  dataLakeAccessGrantRepository: { listByLake: vi.fn().mockResolvedValue([]), upsertGrant: vi.fn() },
  userRepository: {},
  organizationRepository: {},
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../transfer-ownership';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const req = (query: Record<string, string>, body: unknown) => ({ method: 'POST', query, body }) as never;
const call = (r: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);

describe('POST /api/data-lakes/[id]/transfer-ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, administeredOrgIds: [] });
    h.transferLakeOwnership.mockResolvedValue({ newOwnerUserId: 'newOwner', demotedUserIds: ['u1'] });
  });

  it('transfers against the RESOLVED lake and returns the service result verbatim', async () => {
    // assertLakeAccess resolves id-or-slug, so the service must get lake.id, not the raw query value.
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-1', slug: 'my-lake' });
    const { res, json } = makeRes();

    await call(req({ id: 'my-lake' }, { newOwnerUserId: 'newOwner' }), res);

    expect(h.transferLakeOwnership).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', isAdmin: false }),
      'lake-oid-1',
      'newOwner',
      // Not expect.anything(): the config-audit repos ride one shared helper, and a route that
      // dropped `adminSettings` would still compile (it is optional so the retention read stays
      // best-effort) while quietly pinning every event to the floor default.
      expect.objectContaining({
        db: expect.objectContaining({
          lakeConfigChangeEvents: expect.anything(),
          adminSettings: expect.anything(),
        }),
      })
    );
    expect(json).toHaveBeenCalledWith({ newOwnerUserId: 'newOwner', demotedUserIds: ['u1'] });
  });

  it('does not transfer when the access gate denies the lake', async () => {
    h.assertLakeAccess.mockRejectedValue(new Error('Data lake not found'));
    const { res } = makeRes();

    await expect(call(req({ id: 'lake1' }, { newOwnerUserId: 'x' }), res)).rejects.toThrow(/not found/i);
    expect(h.transferLakeOwnership).not.toHaveBeenCalled();
  });

  it('takes the acting principal from the access context, never from the request body', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1' });
    const { res } = makeRes();

    await call(req({ id: 'lake1' }, { newOwnerUserId: 'newOwner', userId: 'attacker', isAdmin: true }), res);

    // The actor is the ctx, not the body-supplied attacker identity; newOwnerUserId still comes from the body.
    expect(h.transferLakeOwnership).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', isAdmin: false }),
      'lake1',
      'newOwner',
      expect.anything()
    );
  });

  it('rejects a missing newOwnerUserId (schema validation)', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1' });
    const { res } = makeRes();

    await expect(call(req({ id: 'lake1' }, {}), res)).rejects.toThrow();
    expect(h.transferLakeOwnership).not.toHaveBeenCalled();
  });
});

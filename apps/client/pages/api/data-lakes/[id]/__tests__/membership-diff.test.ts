import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  resolveCanManageLake: vi.fn(),
  diffLakeMembership: vi.fn(),
  isFallbackLake: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false, administeredOrgIds: [] })),
}));

// baseApi mock: callable chain routed by req.method (same shape as sibling endpoint tests).
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
    resolveCanManageLake: h.resolveCanManageLake,
    diffLakeMembership: h.diffLakeMembership,
    isFallbackLake: h.isFallbackLake,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  fabFileRepository: {},
  lakeMembershipChangeEventRepository: {},
  userRepository: {},
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../membership-diff';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const req = (query: Record<string, string>) => ({ method: 'GET', query, logger: undefined }) as never;
const call = (r: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);

const FROM = '2026-06-01T00:00:00.000Z';
const view = {
  lakeId: 'lake-oid-1',
  from: new Date(FROM),
  to: new Date('2026-07-01T00:00:00.000Z'),
  added: [],
  removed: [],
  truncated: false,
  generatedAt: new Date(),
  userNames: {},
};

describe('GET /api/data-lakes/[id]/membership-diff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, administeredOrgIds: [] });
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-1', name: 'Ops Lake' });
    h.resolveCanManageLake.mockResolvedValue(true);
    h.diffLakeMembership.mockResolvedValue(view);
    h.isFallbackLake.mockReturnValue(false);
  });

  it('returns the diff for a manager', async () => {
    const { res, json } = makeRes();

    await call(req({ id: 'my-lake', from: FROM }), res);

    expect(json).toHaveBeenCalledWith({ data: view });
  });

  it('diffs the RESOLVED lake, not the raw id-or-slug from the URL', async () => {
    const { res } = makeRes();

    await call(req({ id: 'my-lake', from: FROM }), res);

    expect(h.diffLakeMembership).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lake-oid-1' }),
      expect.objectContaining({ from: new Date(FROM) })
    );
  });

  it('passes an explicit window end through', async () => {
    const { res } = makeRes();

    await call(req({ id: 'my-lake', from: FROM, to: '2026-07-01T00:00:00.000Z' }), res);

    expect(h.diffLakeMembership).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: new Date('2026-07-01T00:00:00.000Z') })
    );
  });

  describe('window parameters', () => {
    it('refuses a request with no `from` rather than picking a window for the caller', async () => {
      const { res } = makeRes();

      await expect(call(req({ id: 'lake1' }), res)).rejects.toThrow(/from/i);
      expect(h.diffLakeMembership).not.toHaveBeenCalled();
    });

    it('refuses an unparseable instant rather than diffing a window nobody asked for', async () => {
      const { res } = makeRes();

      await expect(call(req({ id: 'lake1', from: 'last tuesday' }), res)).rejects.toThrow(/ISO-8601/);
      await expect(call(req({ id: 'lake1', from: FROM, to: 'soon' }), res)).rejects.toThrow(/ISO-8601/);
    });

    it('refuses the loose forms `new Date` would have accepted', async () => {
      const { res } = makeRes();

      // A bare year, a locale string, and an offset-less instant: the last would mean a different
      // window on a server in a different timezone.
      await expect(call(req({ id: 'lake1', from: '2026' }), res)).rejects.toThrow(/ISO-8601/);
      await expect(call(req({ id: 'lake1', from: 'June 1 2026' }), res)).rejects.toThrow(/ISO-8601/);
      await expect(call(req({ id: 'lake1', from: '2026-06-01T00:00:00' }), res)).rejects.toThrow(/ISO-8601/);
      expect(h.diffLakeMembership).not.toHaveBeenCalled();
    });

    it('accepts a non-UTC offset', async () => {
      const { res } = makeRes();

      await call(req({ id: 'lake1', from: '2026-06-01T02:00:00+02:00' }), res);

      expect(h.diffLakeMembership).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ from: new Date('2026-06-01T00:00:00.000Z') })
      );
    });

    it('refuses an out-of-range calendar date instead of rolling it into the next month', async () => {
      const { res } = makeRes();

      // `new Date` turns this into March 2nd, which is a window the caller never named.
      await expect(call(req({ id: 'lake1', from: '2026-02-30T00:00:00.000Z' }), res)).rejects.toThrow(
        /does not exist/i
      );
      await expect(call(req({ id: 'lake1', from: FROM, to: '2026-06-31T00:00:00.000Z' }), res)).rejects.toThrow(
        /does not exist/i
      );
      expect(h.diffLakeMembership).not.toHaveBeenCalled();
    });

    it('refuses a `from` in the future, with or without a `to`', async () => {
      const { res } = makeRes();

      // The service clamps the window end to now, so either form ends the window before it starts
      // and the empty read would be served as a confident count of every current member.
      await expect(call(req({ id: 'lake1', from: '2030-01-01T00:00:00.000Z' }), res)).rejects.toThrow(
        /must not be in the future/i
      );
      await expect(
        call(req({ id: 'lake1', from: '2030-01-01T00:00:00.000Z', to: '2031-01-01T00:00:00.000Z' }), res)
      ).rejects.toThrow(/must not be in the future/i);
      expect(h.diffLakeMembership).not.toHaveBeenCalled();
    });

    it('serves an instantaneous window where `to` equals `from`', async () => {
      const { res, json } = makeRes();

      await call(req({ id: 'lake1', from: FROM, to: FROM }), res);

      expect(json).toHaveBeenCalledWith({ data: view });
    });

    it('refuses a backwards window instead of serving an empty diff for it', async () => {
      const { res } = makeRes();

      await expect(call(req({ id: 'lake1', from: FROM, to: '2026-05-01T00:00:00.000Z' }), res)).rejects.toThrow(
        /earlier than/i
      );
      expect(h.diffLakeMembership).not.toHaveBeenCalled();
    });
  });

  describe('gates', () => {
    it('denies a caller who cannot manage the lake', async () => {
      h.resolveCanManageLake.mockResolvedValue(false);
      const { res, json } = makeRes();

      await expect(call(req({ id: 'lake1', from: FROM }), res)).rejects.toThrow(/manage this data lake/i);
      expect(json).not.toHaveBeenCalled();
      // The refusal must happen BEFORE any audit row is read, not after.
      expect(h.diffLakeMembership).not.toHaveBeenCalled();
    });

    it('gates a registry lake on platform admin, not the org-admin rung', async () => {
      // The actor this rung exists to stop: an org admin of the organization the registry config
      // names. `resolveCanManageLake` would hand them a platform lake's history.
      h.isFallbackLake.mockReturnValue(true);
      h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, administeredOrgIds: ['org-1'] });
      h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-1', name: 'Help Lake', organizationId: 'org-1' });
      const { res } = makeRes();

      await expect(call(req({ id: 'help', from: FROM }), res)).rejects.toThrow(/manage this data lake/i);
      expect(h.resolveCanManageLake).not.toHaveBeenCalled();
      expect(h.diffLakeMembership).not.toHaveBeenCalled();
    });

    it('serves a registry lake to a platform admin', async () => {
      h.isFallbackLake.mockReturnValue(true);
      h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: true, administeredOrgIds: [] });
      const { res, json } = makeRes();

      await call(req({ id: 'help', from: FROM }), res);

      expect(json).toHaveBeenCalledWith({ data: view });
    });

    it('propagates the not-found-style access denial so a lake the caller cannot see is not disclosed', async () => {
      h.assertLakeAccess.mockRejectedValue(new Error('Data lake not found'));
      const { res } = makeRes();

      await expect(call(req({ id: 'lake1', from: FROM }), res)).rejects.toThrow(/not found/i);
      expect(h.resolveCanManageLake).not.toHaveBeenCalled();
    });
  });
});

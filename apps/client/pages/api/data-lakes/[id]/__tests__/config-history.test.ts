import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  resolveCanManageLake: vi.fn(),
  assembleLakeConfigHistory: vi.fn(),
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
    assembleLakeConfigHistory: h.assembleLakeConfigHistory,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  lakeConfigChangeEventRepository: {},
  userRepository: {},
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../config-history';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const req = (query: Record<string, string>) => ({ method: 'GET', query, logger: undefined }) as never;
const call = (r: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);

const view = { lakeId: 'lake-oid-1', lakeName: 'Ops Lake', entries: [], truncated: false, generatedAt: new Date() };

describe('GET /api/data-lakes/[id]/config-history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, administeredOrgIds: [] });
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-1', name: 'Ops Lake' });
    h.resolveCanManageLake.mockResolvedValue(true);
    h.assembleLakeConfigHistory.mockResolvedValue(view);
  });

  it('returns the history for a manager', async () => {
    const { res, json } = makeRes();

    await call(req({ id: 'my-lake' }), res);

    expect(json).toHaveBeenCalledWith({ data: view });
  });

  it('assembles against the RESOLVED lake, not the raw id-or-slug from the URL', async () => {
    const { res } = makeRes();

    await call(req({ id: 'my-lake' }), res);

    expect(h.assembleLakeConfigHistory).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lake-oid-1' }),
      expect.anything()
    );
  });

  describe('gates', () => {
    it('denies a caller who cannot manage the lake - the history is editor-only', async () => {
      h.resolveCanManageLake.mockResolvedValue(false);
      const { res, json } = makeRes();

      await expect(call(req({ id: 'lake1' }), res)).rejects.toThrow(/manage this data lake/i);
      expect(json).not.toHaveBeenCalled();
      // The refusal must happen BEFORE any audit row is read, not after.
      expect(h.assembleLakeConfigHistory).not.toHaveBeenCalled();
    });

    it('propagates the not-found-style access denial so a lake the caller cannot see is not disclosed', async () => {
      h.assertLakeAccess.mockRejectedValue(new Error('Data lake not found'));
      const { res } = makeRes();

      await expect(call(req({ id: 'lake1' }), res)).rejects.toThrow(/not found/i);
      expect(h.resolveCanManageLake).not.toHaveBeenCalled();
    });

    it('runs the access gate before the manage gate, so existence is never probed via a 403', async () => {
      const order: string[] = [];
      h.assertLakeAccess.mockImplementation(async () => {
        order.push('access');
        return { id: 'lake-oid-1', name: 'Ops Lake' };
      });
      h.resolveCanManageLake.mockImplementation(async () => {
        order.push('manage');
        return true;
      });
      const { res } = makeRes();

      await call(req({ id: 'lake1' }), res);

      expect(order).toEqual(['access', 'manage']);
    });
  });

  describe('limit', () => {
    it('passes a requested limit through for the service to clamp', async () => {
      const { res } = makeRes();

      await call(req({ id: 'lake1', limit: '25' }), res);

      expect(h.assembleLakeConfigHistory).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ limit: 25 })
      );
    });

    it('sends undefined when no limit was requested, so the service default applies', async () => {
      const { res } = makeRes();

      await call(req({ id: 'lake1' }), res);

      expect(h.assembleLakeConfigHistory).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ limit: undefined })
      );
    });

    it('sends undefined for a BARE ?limit=, not 0 - otherwise the owner silently gets a one-row history', async () => {
      // The reason the route reads `limit ? Number(limit) : undefined` rather than `limit == null`.
      // An empty query value arrives as '', `Number('')` is 0, and the service's clamp floors 0 to 1,
      // so the truthiness check is load-bearing: swapping it for a null check would ship a one-row
      // history with a green suite.
      const { res } = makeRes();

      await call(req({ id: 'lake1', limit: '' }), res);

      expect(h.assembleLakeConfigHistory).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ limit: undefined })
      );
    });

    it('serves a page instead of a 400 for a garbage limit - the service clamps a NaN to the default', async () => {
      const { res, json } = makeRes();

      await call(req({ id: 'lake1', limit: 'abc' }), res);

      expect(json).toHaveBeenCalledWith({ data: view });
      const passed = h.assembleLakeConfigHistory.mock.calls[0][1] as { limit: number };
      expect(Number.isNaN(passed.limit)).toBe(true);
    });
  });
});

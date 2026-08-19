import { describe, it, expect, vi, beforeEach } from 'vitest';

const LAKE = { id: 'lake1', datalakeTag: 'datalake:lake1', createdByUserId: 'creator-1' };

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  resolveCanManageLake: vi.fn(),
  listByLake: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'creator-1', isAdmin: false })),
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
  dataLakeService: { assertLakeAccess: h.assertLakeAccess, resolveCanManageLake: h.resolveCanManageLake },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  dataLakeProposalRepository: { listByLake: h.listByLake },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../index';

const makeReq = (query: Record<string, unknown> = {}) => ({
  method: 'GET',
  query: { id: 'lake1', ...query },
  user: { id: 'creator-1' },
  logger: { warn: vi.fn(), error: vi.fn() },
});

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeAccess.mockResolvedValue(LAKE);
  h.resolveCanManageLake.mockResolvedValue(true);
  h.listByLake.mockResolvedValue([{ id: 'prop-1' }]);
});

describe('GET /api/data-lakes/:id/proposals', () => {
  it('returns the lake queue to a manager', async () => {
    const { res, json } = makeRes();

    await handler(makeReq() as never, res);

    expect(json).toHaveBeenCalledWith({ data: [{ id: 'prop-1' }] });
  });

  it('refuses a caller who can read the lake but not manage it', async () => {
    h.resolveCanManageLake.mockResolvedValue(false);
    const { res } = makeRes();

    await expect(handler(makeReq() as never, res)).rejects.toThrow(/permission to review proposals/);
    expect(h.listByLake).not.toHaveBeenCalled();
  });

  it('passes the status filter through and bounds the page by default', async () => {
    const { res } = makeRes();

    await handler(makeReq({ status: 'pending' }) as never, res);

    expect(h.listByLake).toHaveBeenCalledWith('lake1', { status: 'pending', limit: 50 });
  });

  it('rejects an unknown status rather than silently listing everything', async () => {
    const { res } = makeRes();

    await expect(handler(makeReq({ status: 'auto_approved' }) as never, res)).rejects.toThrow();
    expect(h.listByLake).not.toHaveBeenCalled();
  });

  it('honors an explicit limit', async () => {
    const { res } = makeRes();

    await handler(makeReq({ limit: '5' }) as never, res);

    expect(h.listByLake).toHaveBeenCalledWith('lake1', { status: undefined, limit: 5 });
  });
});

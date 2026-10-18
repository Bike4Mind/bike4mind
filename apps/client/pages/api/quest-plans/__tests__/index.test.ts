import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type RouteHandler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  getHandler: null as null | RouteHandler,
  postHandler: null as null | RouteHandler,
  findByUserIdWithCount: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    get: (...fns: RouteHandler[]) => {
      h.getHandler = fns[fns.length - 1];
      return chain;
    },
    post: (...fns: RouteHandler[]) => {
      h.postHandler = fns[fns.length - 1];
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => () => undefined }));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => undefined }));
vi.mock('@bike4mind/database', () => ({
  questMasterPlanRepository: { findByUserIdWithCount: h.findByUserIdWithCount, create: h.create },
}));

await import('../index');

const USER = 'user-1';
const STRAY = { _id: 'raw-object-id', __v: 3, notInSchema: 'x' };
const STRAY_KEYS = Object.keys(STRAY);

const request = (init: Parameters<typeof createMocks>[0]) => {
  const { req, res } = createMocks(init);
  (req as unknown as { user: { id: string } }).user = { id: USER };
  return { req, res };
};

describe('GET /api/quest-plans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strips undeclared plan fields and keeps pagination and stats', async () => {
    const stats = { total: 12, byState: { active: 12 } };
    h.findByUserIdWithCount.mockResolvedValue({
      plans: [{ id: 'p1', goal: 'One', ...STRAY }],
      total: 12,
      stats,
    });
    const { req, res } = request({ method: 'GET', query: { limit: '5', offset: '0' } });

    await h.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ id: 'p1', goal: 'One' });
    for (const key of STRAY_KEYS) {
      expect(body.data[0]).not.toHaveProperty(key);
    }
    expect(body.pagination).toEqual({ limit: 5, offset: 0, total: 12, hasMore: true });
    expect(body.stats).toEqual(stats);
  });
});

describe('POST /api/quest-plans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers 201 with the created plan stripped of undeclared fields', async () => {
    h.create.mockResolvedValue({ id: 'p1', goal: 'New goal', ...STRAY });
    const { req, res } = request({ method: 'POST', body: { goal: 'New goal' } });

    await h.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(201);
    const body = res._getJSONData();
    expect(body).toMatchObject({ id: 'p1', goal: 'New goal' });
    for (const key of STRAY_KEYS) {
      expect(body).not.toHaveProperty(key);
    }
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type RouteHandler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, RouteHandler>,
  findById: vi.fn(),
  update: vi.fn(),
  isValidStateTransition: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const register =
    (verb: string) =>
    (...fns: RouteHandler[]) => {
      h.handlers[verb] = fns[fns.length - 1];
      return chain;
    };
  const chain = { use: () => chain, get: register('get'), patch: register('patch'), delete: register('delete') };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => () => undefined }));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => undefined }));
vi.mock('@bike4mind/database', () => ({
  questMasterPlanRepository: {
    findById: h.findById,
    update: h.update,
    isValidStateTransition: h.isValidStateTransition,
  },
  userRepository: { findByIds: vi.fn() },
}));

await import('../index');

const USER = 'user-1';
const PLAN_ID = '64b7f0c2a1b2c3d4e5f60718';
const STRAY = { _id: 'raw-object-id', __v: 3, notInSchema: 'x' };
const STRAY_KEYS = Object.keys(STRAY);

const call = async (method: 'GET' | 'PATCH', body?: Record<string, unknown>) => {
  const { req, res } = createMocks({ method, query: { id: PLAN_ID }, body });
  (req as unknown as { user: { id: string } }).user = { id: USER };
  await h.handlers[method.toLowerCase()](req, res);
  return res;
};

describe('GET /api/quest-plans/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strips undeclared plan fields', async () => {
    h.findById.mockResolvedValue({ id: PLAN_ID, userId: USER, goal: 'Goal', ...STRAY });
    h.update.mockResolvedValue(undefined);

    const res = await call('GET');

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body).toMatchObject({ id: PLAN_ID, goal: 'Goal' });
    for (const key of STRAY_KEYS) {
      expect(body).not.toHaveProperty(key);
    }
  });
});

describe('PATCH /api/quest-plans/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findById.mockResolvedValue({ id: PLAN_ID, userId: USER, goal: 'Goal', state: 'active' });
  });

  it('strips undeclared fields from the updated plan', async () => {
    h.update.mockResolvedValue({ id: PLAN_ID, goal: 'Renamed', ...STRAY });

    const res = await call('PATCH', { goal: 'Renamed' });

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body).toMatchObject({ id: PLAN_ID, goal: 'Renamed' });
    for (const key of STRAY_KEYS) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('answers 404 when the update matches nothing', async () => {
    h.update.mockResolvedValue(null);

    const res = await call('PATCH', { goal: 'Renamed' });

    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).toEqual({ error: 'Quest plan not found' });
  });
});

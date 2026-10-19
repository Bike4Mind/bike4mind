import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type RouteHandler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  getHandler: null as null | RouteHandler,
  verify: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    get: (...fns: RouteHandler[]) => {
      h.getHandler = fns[fns.length - 1];
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => undefined }));
vi.mock('@server/utils/questMasterPlanAccess', () => ({ verifyQuestPlanReadAccess: h.verify }));

await import('../index');

const PLAN_ID = '64b7f0c2a1b2c3d4e5f60718';

describe('GET /api/quest-master-plans/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strips fields the plan schema does not declare', async () => {
    h.verify.mockResolvedValue({ id: PLAN_ID, goal: 'Goal', _id: 'raw-object-id', __v: 2, notInSchema: 'x' });
    const { req, res } = createMocks({ method: 'GET', query: { id: PLAN_ID } });
    (req as unknown as { user: { id: string } }).user = { id: 'user-1' };

    await h.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body).toMatchObject({ id: PLAN_ID, goal: 'Goal' });
    for (const key of ['_id', '__v', 'notInSchema']) {
      expect(body).not.toHaveProperty(key);
    }
    expect(h.verify).toHaveBeenCalledWith('user-1', PLAN_ID);
  });
});

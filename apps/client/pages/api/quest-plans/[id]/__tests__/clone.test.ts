import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type RouteHandler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  postHandler: null as null | RouteHandler,
  findById: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    post: (...fns: RouteHandler[]) => {
      h.postHandler = fns[fns.length - 1];
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => () => undefined }));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => undefined }));
vi.mock('@bike4mind/database', () => ({
  questMasterPlanRepository: { findById: h.findById, create: h.create },
}));

await import('../clone');

const USER = 'user-1';
const PLAN_ID = '64b7f0c2a1b2c3d4e5f60718';

describe('POST /api/quest-plans/[id]/clone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findById.mockResolvedValue({ id: PLAN_ID, userId: USER, goal: 'Goal', quests: [], tags: [] });
  });

  it('answers 201 with the cloned plan stripped of undeclared fields', async () => {
    h.create.mockResolvedValue({ id: 'clone-1', goal: 'Goal (Copy)', _id: 'raw-object-id', __v: 0, notInSchema: 'x' });
    const { req, res } = createMocks({ method: 'POST', query: { id: PLAN_ID }, body: {} });
    (req as unknown as { user: { id: string } }).user = { id: USER };

    await h.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(201);
    const body = res._getJSONData();
    expect(body.success).toBe(true);
    expect(body.plan).toMatchObject({ id: 'clone-1', goal: 'Goal (Copy)' });
    for (const key of ['_id', '__v', 'notInSchema']) {
      expect(body.plan).not.toHaveProperty(key);
    }
  });
});

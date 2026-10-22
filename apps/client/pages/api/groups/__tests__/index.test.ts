import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type RouteHandler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  getHandler: null as null | RouteHandler,
  find: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    get: (...fns: RouteHandler[]) => {
      h.getHandler = fns[fns.length - 1];
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: RouteHandler) => fn }));
vi.mock('@bike4mind/database/social', () => ({ Group: { find: h.find } }));

await import('../index');

const call = async (user: unknown) => {
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as { user: unknown }).user = user;
  await h.getHandler!(req, res);
  return res;
};

describe('GET /api/groups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strips fields the group schema does not declare', async () => {
    h.find.mockResolvedValue([
      { id: 'g1', name: 'Team', _id: 'raw-object-id', __v: 1, deletedAt: new Date('2026-01-01T00:00:00Z') },
    ]);

    const res = await call({ id: 'u1', groups: ['g1'] });

    expect(res._getStatusCode()).toBe(200);
    const { groups } = res._getJSONData();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: 'g1', name: 'Team' });
    for (const key of ['_id', '__v', 'deletedAt']) {
      expect(groups[0]).not.toHaveProperty(key);
    }
  });

  it('answers an empty list without querying when the user has no groups', async () => {
    const res = await call({ id: 'u1', groups: [] });

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ groups: [] });
    expect(h.find).not.toHaveBeenCalled();
  });
});

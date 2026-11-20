// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  getHandler: null as null | ((req: unknown, res: unknown) => unknown),
  listRecentActivities: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, unknown> = {
    use: () => chain,
    get: (fn: (req: unknown, res: unknown) => unknown) => {
      h.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/database', () => ({ CounterLog: {} }));
vi.mock('@bike4mind/services', () => ({ userService: { listRecentActivities: h.listRecentActivities } }));

import '../recent';

describe('GET /api/users/activities/recent - response boundary', () => {
  it('strips undeclared keys from each log and keeps declared ones', async () => {
    h.listRecentActivities.mockResolvedValue([
      { id: 'l1', userId: 'u1', counterName: 'login', counterValue: 1, _id: 'oid1', __v: 0, secretNotInSchema: 'x' },
    ]);
    const { req, res } = createMocks({ method: 'GET', query: {} });
    (req as unknown as { user: unknown }).user = { id: 'u1', isAdmin: false };

    await h.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body).toEqual([{ id: 'l1', userId: 'u1', counterName: 'login', counterValue: 1 }]);
    expect(body[0]).not.toHaveProperty('_id');
    expect(body[0]).not.toHaveProperty('__v');
    expect(body[0]).not.toHaveProperty('secretNotInSchema');
  });
});

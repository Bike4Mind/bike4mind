// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  getHandler: null as null | ((req: unknown, res: unknown) => unknown),
  find: vi.fn(),
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
vi.mock('@casl/mongoose', () => ({ accessibleBy: () => ({ ofType: () => ({}) }) }));
vi.mock('@bike4mind/database', () => ({ UserActivityCounter: { find: h.find } }));

import '../index';

describe('GET /api/users/[id]/activities - response boundary', () => {
  it('strips undeclared keys from each counter and keeps declared ones', async () => {
    h.find.mockResolvedValue([
      { id: 'c1', userId: 'u1', action: 'login', count: 3, tags: ['a'], _id: 'oid1', __v: 4, secretNotInSchema: 'x' },
    ]);
    const { req, res } = createMocks({ method: 'GET', query: { id: 'u1' } });
    (req as unknown as { ability: unknown }).ability = {};

    await h.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body).toEqual([{ id: 'c1', userId: 'u1', action: 'login', count: 3, tags: ['a'] }]);
    expect(body[0]).not.toHaveProperty('_id');
    expect(body[0]).not.toHaveProperty('__v');
    expect(body[0]).not.toHaveProperty('secretNotInSchema');
  });
});

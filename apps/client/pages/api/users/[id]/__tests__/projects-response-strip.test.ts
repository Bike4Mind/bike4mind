// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  getHandler: null as null | ((req: unknown, res: unknown) => unknown),
  findById: vi.fn(),
  findAllAccessible: vi.fn(),
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
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findById },
  projectRepository: { shareable: { findAllAccessible: h.findAllAccessible } },
}));

import '../projects';

describe('GET /api/users/[id]/projects - response boundary', () => {
  it('strips undeclared keys from each project and keeps declared ones', async () => {
    h.findById.mockResolvedValue({ id: 'me' });
    h.findAllAccessible.mockResolvedValue([
      { id: 'p1', name: 'Alpha', userId: 'me', _id: 'oid1', __v: 2, secretNotInSchema: 'x' },
    ]);
    const { req, res } = createMocks({ method: 'GET', query: { id: 'me' } });
    (req as unknown as { user: unknown }).user = { id: 'me', isAdmin: false };

    await h.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body).toEqual([{ id: 'p1', name: 'Alpha', userId: 'me' }]);
    expect(body[0]).not.toHaveProperty('_id');
    expect(body[0]).not.toHaveProperty('__v');
    expect(body[0]).not.toHaveProperty('secretNotInSchema');
  });
});

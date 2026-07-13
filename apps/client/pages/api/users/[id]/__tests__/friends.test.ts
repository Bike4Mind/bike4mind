import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * /api/users/[id]/friends resolves a user's friend list to full user records
 * (including email), so only the user themselves or an admin may read it. Prove
 * the gate rejects a cross-user read before calling the service.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const listFriends = vi.hoisted(() => vi.fn().mockResolvedValue([{ id: 'f1', user: { id: 'u2' } }]));
vi.mock('@bike4mind/services', () => ({ friendshipService: { listFriends } }));
vi.mock('@bike4mind/database', () => ({
  compareMongoIds: (a: string, b: string) => a === b,
  friendshipRepository: {},
  userRepository: {},
}));

import '@pages/api/users/[id]/friends';

function mocks(user: unknown, id: string) {
  const { req, res } = createMocks({ method: 'GET', query: { id } });
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/users/[id]/friends — ownership gate', () => {
  beforeEach(() => listFriends.mockClear());

  it('rejects reading another user\'s friends without calling the service', async () => {
    const { req, res } = mocks({ id: 'me', isAdmin: false }, 'someone-else');
    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow(/not authorized/i);
    expect(listFriends).not.toHaveBeenCalled();
  });

  it('allows a user to read their own friends', async () => {
    const { req, res } = mocks({ id: 'me', isAdmin: false }, 'me');
    await mockRefs.getHandler!(req, res);
    expect(listFriends).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
  });

  it('allows an admin to read any user\'s friends', async () => {
    const { req, res } = mocks({ id: 'admin1', isAdmin: true }, 'someone-else');
    await mockRefs.getHandler!(req, res);
    expect(listFriends).toHaveBeenCalledTimes(1);
  });
});

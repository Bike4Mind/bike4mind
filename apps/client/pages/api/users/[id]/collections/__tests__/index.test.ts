import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * A user's collections are private to them, so /api/users/[id]/collections must
 * be readable only by the user themselves or an admin. Prove the gate rejects a
 * cross-user read before calling the service.
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

const searchUserCollection = vi.hoisted(() => vi.fn().mockResolvedValue({ data: [], hasMore: false }));
vi.mock('@bike4mind/services', () => ({ userService: { searchUserCollection } }));
vi.mock('@bike4mind/database', () => ({ userRepository: {}, sessionRepository: {} }));

import '@pages/api/users/[id]/collections/index';

function mocks(user: unknown, id: string) {
  const { req, res } = createMocks({ method: 'GET', query: { id, page: '1' } });
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/users/[id]/collections - ownership gate', () => {
  beforeEach(() => searchUserCollection.mockClear());

  it("rejects reading another user's collections without calling the service", async () => {
    const { req, res } = mocks({ id: 'me', isAdmin: false }, 'someone-else');
    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow(/not authorized/i);
    expect(searchUserCollection).not.toHaveBeenCalled();
  });

  it('allows a user to read their own collections', async () => {
    const { req, res } = mocks({ id: 'me', isAdmin: false }, 'me');
    await mockRefs.getHandler!(req, res);
    expect(searchUserCollection).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
  });

  it("allows an admin to read any user's collections", async () => {
    const { req, res } = mocks({ id: 'admin1', isAdmin: true }, 'someone-else');
    await mockRefs.getHandler!(req, res);
    expect(searchUserCollection).toHaveBeenCalledTimes(1);
  });
});

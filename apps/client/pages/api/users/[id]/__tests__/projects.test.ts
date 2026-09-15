import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * /api/users/[id]/projects resolves to the target user's owned + shared-to-them
 * projects, so only the user themselves or an admin may list them. Prove the gate
 * rejects a cross-user read before hitting the repository.
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

const findById = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'target' }));
const findAllAccessible = vi.hoisted(() => vi.fn().mockResolvedValue([{ id: 'p1' }]));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById },
  projectRepository: { shareable: { findAllAccessible } },
}));

import '@pages/api/users/[id]/projects';

function mocks(user: unknown, id: string) {
  const { req, res } = createMocks({ method: 'GET', query: { id } });
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/users/[id]/projects - ownership gate', () => {
  beforeEach(() => {
    findById.mockClear();
    findAllAccessible.mockClear();
  });

  it("rejects reading another user's projects without hitting the repository", async () => {
    const { req, res } = mocks({ id: 'me', isAdmin: false }, 'someone-else');
    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow(/not authorized/i);
    expect(findById).not.toHaveBeenCalled();
    expect(findAllAccessible).not.toHaveBeenCalled();
  });

  it('allows a user to read their own projects', async () => {
    const { req, res } = mocks({ id: 'me', isAdmin: false }, 'me');
    await mockRefs.getHandler!(req, res);
    expect(findAllAccessible).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
  });

  it("allows an admin to read any user's projects", async () => {
    const { req, res } = mocks({ id: 'admin1', isAdmin: true }, 'someone-else');
    await mockRefs.getHandler!(req, res);
    expect(findAllAccessible).toHaveBeenCalledTimes(1);
  });
});

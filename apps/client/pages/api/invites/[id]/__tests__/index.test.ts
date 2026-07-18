import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * DELETE /api/invites/[id] delegates to sharingService.cancelInviteById (share-scoped
 * auth lives in the service). Asserts delegation + the id guard.
 */

const mockRefs = vi.hoisted(() => ({ deleteHandler: null as null | ((req: any, res: any) => unknown) }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    post: () => chain,
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const cancelInviteById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({ sharingService: { cancelInviteById } }));
vi.mock('@bike4mind/database', () => ({
  Invite: { findById: vi.fn() },
  inviteRepository: {},
  fabFileRepository: {},
  sessionRepository: {},
  projectRepository: {},
  organizationRepository: {},
  Group: {},
}));
vi.mock('@server/managers/inviteManager', () => ({ getInviteDetails: vi.fn() }));

import '@pages/api/invites/[id]/index';

describe('DELETE /api/invites/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to cancelInviteById with the invite id and returns the result', async () => {
    cancelInviteById.mockResolvedValue({ id: 'inv-1', remaining: 0 });
    const { req, res } = createMocks({ method: 'DELETE', query: { id: 'inv-1' } });
    (req as any).user = { id: 'u1' };
    await mockRefs.deleteHandler!(req, res);

    expect(cancelInviteById).toHaveBeenCalledWith(
      req.user,
      { id: 'inv-1' },
      expect.objectContaining({ db: expect.any(Object) })
    );
    expect(res._getJSONData()).toEqual({ id: 'inv-1', remaining: 0 });
  });

  it('returns 400 when id is missing', async () => {
    const { req, res } = createMocks({ method: 'DELETE', query: {} });
    (req as any).user = { id: 'u1' };
    await mockRefs.deleteHandler!(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(cancelInviteById).not.toHaveBeenCalled();
  });
});

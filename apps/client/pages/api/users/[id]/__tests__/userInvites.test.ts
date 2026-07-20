import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/users/:id/userInvites is the invitee inbox. Each invite's recipient
 * arrays must be filtered to the caller's own email (the inbox checks
 * recipients.pending for the caller) so co-invitees' emails are not leaked.
 */

// `any` below is deliberate test-mock plumbing: typing the full next-connect /
// node-mocks-http chain adds no coverage value (matches the repo's handler-test convention).
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

const listOwnPendingInvites = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({
  sharingService: { listOwnPendingInvites },
  // Cache is a pass-through in tests: run the factory directly.
  cacheService: { getCachedData: (_key: string, factory: () => unknown) => factory() },
}));
// inviteRepository/cacheRepository for the handler + FabFile.. for inviteManager's load.
vi.mock('@bike4mind/database', () => ({
  inviteRepository: {},
  cacheRepository: {},
  FabFile: {},
  Group: {},
  Organization: {},
  Session: {},
  User: {},
}));
vi.mock('@server/utils/cacheKeys', () => ({ CacheKeys: { userInvites: () => 'k' } }));

import '@pages/api/users/[id]/userInvites';

describe('GET /api/users/[id]/userInvites - inbox recipient filtering', () => {
  beforeEach(() => listOwnPendingInvites.mockClear());

  it('filters each invite to the caller, keeping the pending self-check working', async () => {
    listOwnPendingInvites.mockResolvedValue({
      data: [{ id: 'i1', recipients: { pending: ['me@x.com', 'other@x.com'], accepted: [], refused: [] } }],
      total: 1,
    });
    const { req, res } = createMocks({ method: 'GET', query: { id: 'me' } });
    (req as any).user = { id: 'me', email: 'me@x.com', isAdmin: false };
    await mockRefs.getHandler!(req, res);

    const body = res._getJSONData();
    expect(body.data[0].recipients.pending).toEqual(['me@x.com']);
    expect(body.pagination.total).toBe(1);
    expect(JSON.stringify(body)).not.toContain('other@x.com');
  });
});

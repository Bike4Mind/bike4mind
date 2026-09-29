import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { NotFoundError } from '@server/utils/errors';

const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: any, res: any) => unknown),
  revokedGrant: null as any,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: any) => fn,
}));

vi.mock('@bike4mind/database', () => ({
  oauthGrantRepository: {
    revoke: () => Promise.resolve(mockRefs.revokedGrant),
  },
}));

vi.mock('@server/utils/authAudit', () => ({
  logAuthAudit: vi.fn().mockResolvedValue(undefined),
}));

import '../[clientId]';

describe('DELETE /api/oauth/grants/[clientId]', () => {
  beforeEach(() => {
    mockRefs.revokedGrant = { clientId: 'client-a', userId: 'u1', revokedAt: new Date() };
  });

  it('returns 200 and revoked:true on a successful revoke', async () => {
    const { req, res } = createMocks({ method: 'DELETE', query: { clientId: 'client-a' } });
    req.user = { id: 'u1' };
    await mockRefs.deleteHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getData())).toEqual({ revoked: true, clientId: 'client-a' });
  });

  it('throws NotFoundError when the grant does not exist for this user', async () => {
    mockRefs.revokedGrant = null;
    const { req, res } = createMocks({ method: 'DELETE', query: { clientId: 'no-such-client' } });
    req.user = { id: 'u1' };
    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow(NotFoundError);
  });
});

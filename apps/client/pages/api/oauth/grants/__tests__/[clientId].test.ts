import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';

const { mockRefs, mockRevoke, mockRevokeAllForGrant, mockLogAuthAudit } = vi.hoisted(() => ({
  mockRefs: {
    deleteHandler: null as null | ((req: any, res: any) => unknown),
  },
  mockRevoke: vi.fn(),
  mockRevokeAllForGrant: vi.fn(),
  mockLogAuthAudit: vi.fn().mockResolvedValue(undefined),
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
    revoke: mockRevoke,
  },
  oauthRefreshTokenRepository: {
    revokeAllForGrant: mockRevokeAllForGrant,
  },
}));

vi.mock('@server/utils/authAudit', () => ({
  logAuthAudit: mockLogAuthAudit,
}));

import '../[clientId]';

describe('DELETE /api/oauth/grants/[clientId]', () => {
  beforeEach(() => {
    mockRevoke.mockResolvedValue({ clientId: 'client-a', userId: 'u1', revokedAt: new Date() });
    mockLogAuthAudit.mockClear();
    mockRevoke.mockClear();
    mockRevokeAllForGrant.mockClear();
  });

  it('revokes the refresh-token families for the revoked grant', async () => {
    const { req, res } = createMocks({ method: 'DELETE', query: { clientId: 'client-a' } });
    req.user = { id: 'u1' };
    await mockRefs.deleteHandler!(req, res);
    expect(mockRevokeAllForGrant).toHaveBeenCalledWith('u1', 'client-a');
  });

  it('returns 200 and revoked:true on a successful revoke', async () => {
    const { req, res } = createMocks({ method: 'DELETE', query: { clientId: 'client-a' } });
    req.user = { id: 'u1' };
    await mockRefs.deleteHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getData())).toEqual({ revoked: true, clientId: 'client-a' });
  });

  it('revokes using the caller userId, not the clientId, so cross-account revocation is impossible', async () => {
    const { req, res } = createMocks({ method: 'DELETE', query: { clientId: 'client-a' } });
    req.user = { id: 'u1' };
    await mockRefs.deleteHandler!(req, res);
    expect(mockRevoke).toHaveBeenCalledWith('u1', 'client-a');
  });

  it('writes an audit log entry on a successful revoke', async () => {
    const { req, res } = createMocks({ method: 'DELETE', query: { clientId: 'client-a' } });
    req.user = { id: 'u1' };
    await mockRefs.deleteHandler!(req, res);
    expect(mockLogAuthAudit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ event: 'oauth_grant_revoked', metadata: { clientId: 'client-a' } })
    );
  });

  it('throws NotFoundError and skips the audit log when the grant does not exist for this user', async () => {
    mockRevoke.mockResolvedValue(null);
    const { req, res } = createMocks({ method: 'DELETE', query: { clientId: 'no-such-client' } });
    req.user = { id: 'u1' };
    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow(NotFoundError);
    expect(mockLogAuthAudit).not.toHaveBeenCalled();
    expect(mockRevokeAllForGrant).not.toHaveBeenCalled();
  });

  it('throws ForbiddenError and skips revoke when called from an impersonated session', async () => {
    const { req, res } = createMocks({ method: 'DELETE', query: { clientId: 'client-a' } });
    req.user = { id: 'u1', impersonatedBy: 'admin-id' };
    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow(ForbiddenError);
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(mockLogAuthAudit).not.toHaveBeenCalled();
  });
});

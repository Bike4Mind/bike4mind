import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * POST /api/users/me/sessions/logout-all - the "log out all devices" panic lever (issue #1194).
 * Unlike per-device logout it DOES bump tokenVersion (via userService.revokeUserSessions) so every
 * device stops immediately. It must refuse for an impersonating admin (would nuke the real
 * customer) and for API-key callers, and must still succeed if the account was deleted mid-request.
 */
const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
  isApiKey: false,
  revokeUserSessions: null as null | ReturnType<typeof vi.fn>,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database', () => ({ userRepository: {}, authSessionRepository: {} }));
vi.mock('@bike4mind/services', () => {
  mockRefs.revokeUserSessions = vi.fn().mockResolvedValue(3);
  return { userService: { revokeUserSessions: mockRefs.revokeUserSessions } };
});
vi.mock('@server/middlewares/apiKeyAuth', () => ({ isApiKeyAuth: () => mockRefs.isApiKey }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn().mockResolvedValue(undefined) }));

import '@pages/api/users/me/sessions/logout-all';

function mocks(user: unknown) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as any).user = user;
  return { req, res };
}

describe('POST /api/users/me/sessions/logout-all', () => {
  beforeEach(() => {
    mockRefs.isApiKey = false;
    mockRefs.revokeUserSessions?.mockClear();
    mockRefs.revokeUserSessions?.mockResolvedValue(3);
  });

  it('revokes all sessions (tokenVersion bump) for a normal user', async () => {
    const { req, res } = mocks({ id: 'user-1', sid: 'sid-1' });
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockRefs.revokeUserSessions).toHaveBeenCalledWith('user-1', expect.anything());
  });

  it('refuses (403) and does not revoke when an admin is impersonating', async () => {
    const { req, res } = mocks({ id: 'customer-1', sid: 'imp-sid', impersonatedBy: 'admin-9' });
    await expect(mockRefs.postHandler!(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(mockRefs.revokeUserSessions).not.toHaveBeenCalled();
  });

  it('refuses (403) for an API-key caller', async () => {
    mockRefs.isApiKey = true;
    const { req, res } = mocks({ id: 'user-1', sid: 'sid-1' });
    await expect(mockRefs.postHandler!(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(mockRefs.revokeUserSessions).not.toHaveBeenCalled();
  });

  it('still returns 200 when the account was deleted between auth and the revoke', async () => {
    const { NotFoundError } = await import('@bike4mind/common');
    mockRefs.revokeUserSessions!.mockRejectedValueOnce(new NotFoundError('User user-1 not found'));
    const { req, res } = mocks({ id: 'user-1', sid: 'sid-1' });
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
  });
});

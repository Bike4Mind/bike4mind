import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * /api/logout revokes sessions server-side (tokenVersion bump). This is the security
 * fix's only production wiring, so it is asserted here directly: a normal authenticated
 * session revokes; an API-key caller and an impersonating admin must NOT (an any-scope key
 * would become an account-wide kill switch; an impersonated logout would force-log-out the
 * real customer on every device).
 */

// `any` below is deliberate test-mock plumbing for the next-connect / node-mocks-http chain.
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  isApiKey: false,
  revokeUserSessions: null as null | ReturnType<typeof vi.fn>,
  updateLogoutTime: null as null | ReturnType<typeof vi.fn>,
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

vi.mock('@bike4mind/database', () => ({ userRepository: {} }));
vi.mock('@bike4mind/services', () => {
  mockRefs.revokeUserSessions = vi.fn().mockResolvedValue(1);
  mockRefs.updateLogoutTime = vi.fn().mockResolvedValue(undefined);
  return {
    userService: {
      revokeUserSessions: mockRefs.revokeUserSessions,
      updateLogoutTime: mockRefs.updateLogoutTime,
    },
  };
});
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/middlewares/apiKeyAuth', () => ({ isApiKeyAuth: () => mockRefs.isApiKey }));

import '@pages/api/logout';

function mocks(user: unknown) {
  const { req, res } = createMocks({ method: 'GET' });
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/logout - server-side session revocation', () => {
  beforeEach(() => {
    mockRefs.isApiKey = false;
    mockRefs.revokeUserSessions?.mockClear();
    mockRefs.updateLogoutTime?.mockClear();
  });

  it('revokes sessions for a normal authenticated session', async () => {
    const { req, res } = mocks({ id: 'user-1' });
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockRefs.revokeUserSessions).toHaveBeenCalledWith('user-1', expect.anything());
  });

  it('does NOT revoke for an API-key caller (no account-wide kill switch)', async () => {
    mockRefs.isApiKey = true;
    const { req, res } = mocks({ id: 'user-1' });
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockRefs.revokeUserSessions).not.toHaveBeenCalled();
    // Logout time is still stamped - only the revoke is gated.
    expect(mockRefs.updateLogoutTime).toHaveBeenCalled();
  });

  it('does NOT revoke when an admin is impersonating the user', async () => {
    const { req, res } = mocks({ id: 'customer-1', impersonatedBy: 'admin-9' });
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockRefs.revokeUserSessions).not.toHaveBeenCalled();
  });

  it('still returns 200 when the account was deleted between auth and the revoke bump', async () => {
    const { NotFoundError } = await import('@bike4mind/utils');
    mockRefs.revokeUserSessions?.mockRejectedValueOnce(new NotFoundError('User user-1 not found'));
    const { req, res } = mocks({ id: 'user-1' });
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
  });
});

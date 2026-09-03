import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * /api/logout is per-device (issue #1194): it revokes ONLY the requesting session (`sid`) via the
 * session store and NEVER bumps tokenVersion, so other devices stay signed in. This is the security
 * fix's only production wiring, so it is asserted here directly: a normal session revokes its own
 * sid; an API-key caller and a legacy token with no sid revoke nothing; and no path bumps
 * tokenVersion (the old all-device hammer - `userService.revokeUserSessions` - must never be called).
 */

// `any` below is deliberate test-mock plumbing for the next-connect / node-mocks-http chain.
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  isApiKey: false,
  revokeSession: null as null | ReturnType<typeof vi.fn>,
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

vi.mock('@bike4mind/database', () => ({ userRepository: {}, authSessionRepository: {} }));
vi.mock('@bike4mind/services', () => {
  mockRefs.revokeSession = vi.fn().mockResolvedValue({ sid: 'sid-1' });
  mockRefs.revokeUserSessions = vi.fn().mockResolvedValue(1);
  mockRefs.updateLogoutTime = vi.fn().mockResolvedValue(undefined);
  return {
    userService: {
      revokeUserSessions: mockRefs.revokeUserSessions,
      updateLogoutTime: mockRefs.updateLogoutTime,
    },
    authSessionService: {
      revokeSession: mockRefs.revokeSession,
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

describe('GET /api/logout - per-device session revocation', () => {
  beforeEach(() => {
    mockRefs.isApiKey = false;
    mockRefs.revokeSession?.mockClear();
    mockRefs.revokeUserSessions?.mockClear();
    mockRefs.updateLogoutTime?.mockClear();
  });

  it('revokes ONLY the requesting session and never bumps tokenVersion', async () => {
    const { req, res } = mocks({ id: 'user-1', sid: 'sid-1' });
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockRefs.revokeSession).toHaveBeenCalledWith('sid-1', expect.anything());
    // The old all-device hammer must be gone.
    expect(mockRefs.revokeUserSessions).not.toHaveBeenCalled();
    expect(mockRefs.updateLogoutTime).toHaveBeenCalled();
  });

  it('does NOT revoke for an API-key caller (no browser session to revoke)', async () => {
    mockRefs.isApiKey = true;
    const { req, res } = mocks({ id: 'user-1', sid: 'sid-1' });
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockRefs.revokeSession).not.toHaveBeenCalled();
    // Logout time is still stamped - only the revoke is gated.
    expect(mockRefs.updateLogoutTime).toHaveBeenCalled();
  });

  it('does NOT revoke when the token carries no sid (legacy pre-session-store token)', async () => {
    const { req, res } = mocks({ id: 'user-1' });
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockRefs.revokeSession).not.toHaveBeenCalled();
    expect(mockRefs.revokeUserSessions).not.toHaveBeenCalled();
  });

  it('revokes only the impersonation session (never the customer-wide tokenVersion) when impersonating', async () => {
    const { req, res } = mocks({ id: 'customer-1', sid: 'imp-sid', impersonatedBy: 'admin-9' });
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockRefs.revokeSession).toHaveBeenCalledWith('imp-sid', expect.anything());
    expect(mockRefs.revokeUserSessions).not.toHaveBeenCalled();
  });
});

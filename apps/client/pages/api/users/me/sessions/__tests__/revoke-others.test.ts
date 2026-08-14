import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * POST /api/users/me/sessions/revoke-others - "log out of all other devices" (issue #1194). Revokes
 * every session EXCEPT the caller's current one (passed as `exceptSid`) and must NOT bump
 * tokenVersion, so the current device stays signed in. It refuses for an impersonating admin and
 * API-key callers, and refuses when the current sid is unknown (else it would revoke ALL sessions,
 * signing the caller out).
 */
const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
  isApiKey: false,
  revokeAllUserSessions: null as null | ReturnType<typeof vi.fn>,
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

vi.mock('@bike4mind/database', () => ({ authSessionRepository: {} }));
vi.mock('@bike4mind/services', () => {
  mockRefs.revokeAllUserSessions = vi.fn().mockResolvedValue(2);
  return { authSessionService: { revokeAllUserSessions: mockRefs.revokeAllUserSessions } };
});
vi.mock('@server/middlewares/apiKeyAuth', () => ({ isApiKeyAuth: () => mockRefs.isApiKey }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn().mockResolvedValue(undefined) }));

import '@pages/api/users/me/sessions/revoke-others';

function mocks(user: unknown) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as any).user = user;
  return { req, res };
}

describe('POST /api/users/me/sessions/revoke-others', () => {
  beforeEach(() => {
    mockRefs.isApiKey = false;
    mockRefs.revokeAllUserSessions?.mockClear();
  });

  it('revokes all sessions EXCEPT the current one, with no tokenVersion bump', async () => {
    const { req, res } = mocks({ id: 'user-1', sid: 'current-sid' });
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockRefs.revokeAllUserSessions).toHaveBeenCalledWith(
      'user-1',
      { exceptSid: 'current-sid' },
      expect.anything()
    );
  });

  it('refuses (403) and does not revoke when an admin is impersonating', async () => {
    const { req, res } = mocks({ id: 'customer-1', sid: 'imp-sid', impersonatedBy: 'admin-9' });
    await expect(mockRefs.postHandler!(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(mockRefs.revokeAllUserSessions).not.toHaveBeenCalled();
  });

  it('refuses (403) for an API-key caller', async () => {
    mockRefs.isApiKey = true;
    const { req, res } = mocks({ id: 'user-1', sid: 'current-sid' });
    await expect(mockRefs.postHandler!(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(mockRefs.revokeAllUserSessions).not.toHaveBeenCalled();
  });

  it('422s (never revokes ALL) when the current session id is unknown', async () => {
    const { req, res } = mocks({ id: 'user-1' }); // no sid
    await expect(mockRefs.postHandler!(req, res)).rejects.toMatchObject({ statusCode: 422 });
    expect(mockRefs.revokeAllUserSessions).not.toHaveBeenCalled();
  });
});

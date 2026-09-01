import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Unwrap the chainable baseApi builder so the raw handler can be invoked directly
// (same idiom as refreshToken.test.ts).
vi.mock('@server/middlewares/baseApi', () => {
  const builder: any = { use: () => builder, post: (fn: any) => fn };
  return { baseApi: () => builder };
});
vi.mock('@server/middlewares/checkBlockedIP', () => ({
  checkBlockedIP: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@server/utils/errors', () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock('@server/auth/requireNonSystemUser', () => ({ requireNonSystemUser: vi.fn() }));
vi.mock('@server/auth/tokenGenerator', () => ({
  authTokenGenerator: { signAccessToken: vi.fn() },
}));
vi.mock('@bike4mind/common', () => ({ redactUserSecretsForSelf: (user: unknown) => user }));

const mockRotateSession = vi.fn();
vi.mock('@bike4mind/services', () => ({
  authSessionService: {
    isOpaqueRefreshToken: (t: string) => t.includes('.'),
    parseRefreshToken: (t: string) => (t.includes('.') ? { sid: t.split('.')[0], secret: t.split('.')[1] } : null),
    rotateSession: (...args: any[]) => mockRotateSession(...args),
  },
}));

const mockRevokeBySid = vi.fn();
const mockFindBySid = vi.fn();
vi.mock('@bike4mind/database', () => ({
  userRepository: {},
  authSessionRepository: {
    revokeBySid: (...args: any[]) => mockRevokeBySid(...args),
    findBySid: (...args: any[]) => mockFindBySid(...args),
  },
}));

import handler from '../returnToAdmin';

/** baseApi normally attaches req.logger; the mocked builder skips its middleware chain. */
const post = (cookie: string) => {
  const { req, res } = createMocks({ method: 'POST', headers: { cookie } });
  (req as unknown as { logger: unknown }).logger = { error: vi.fn(), log: vi.fn(), info: vi.fn() };
  return { req, res };
};

describe('POST /api/auth/returnToAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRevokeBySid.mockResolvedValue(undefined);
    mockRotateSession.mockResolvedValue({
      status: 'rotated',
      user: { id: 'admin-1' },
      userId: 'admin-1',
      accessToken: 'admin-access',
      refreshToken: 'admin-refresh-rotated',
      sid: 'admin-sid',
      impersonatedBy: null,
    });
    // The impersonation session this admin created.
    mockFindBySid.mockResolvedValue({ sid: 'cust-sid', impersonatedBy: 'admin-1' });
  });

  it('restores the admin session: rotates the parked token into the primary cookie and clears the return cookie', async () => {
    const { req, res } = post('b4m_rt=cust-sid.cust-secret; b4m_rt_admin=admin-sid.admin-secret');

    await handler(req as any, res as any);

    expect(mockRotateSession).toHaveBeenCalledWith('admin-sid.admin-secret', expect.anything());

    const cookies = (res.getHeader('Set-Cookie') as string[]).map(String);
    expect(cookies.some(c => c.startsWith('b4m_rt=admin-refresh-rotated;'))).toBe(true);
    // The return slot must be emptied, or a second "return to admin" would replay a dead token.
    expect(cookies.some(c => c.startsWith('b4m_rt_admin=;') && c.includes('Max-Age=0'))).toBe(true);

    expect(res._getJSONData()).toMatchObject({ accessToken: 'admin-access', impersonating: false });
  });

  it('revokes the impersonation session so the abandoned customer token cannot be refreshed later', async () => {
    const { req, res } = post('b4m_rt=cust-sid.cust-secret; b4m_rt_admin=admin-sid.admin-secret');

    await handler(req as any, res as any);

    expect(mockRevokeBySid).toHaveBeenCalledWith('cust-sid');
  });

  it('still returns the admin to safety when revoking the impersonation session fails', async () => {
    // Stranding an admin inside an impersonation is worse than a lingering session row.
    mockRevokeBySid.mockRejectedValue(new Error('db down'));
    const { req, res } = post('b4m_rt=cust-sid.cust-secret; b4m_rt_admin=admin-sid.admin-secret');

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
  });

  it('writes NO cookies when a concurrent rotation already advanced the parked admin session', async () => {
    // Both writes are gated together. Clearing the return slot here would drop the admin's only
    // durable credential while the primary slot still holds the impersonated token - a 30-minute
    // access token and then a forced re-login. Worse, the impersonation revoke is best-effort, so
    // if it failed the primary slot holds a LIVE impersonated token while the response says
    // impersonating: false, and the next refresh silently reinstates that identity.
    mockRotateSession.mockResolvedValue({
      status: 'coalesced',
      user: { id: 'admin-1' },
      userId: 'admin-1',
      accessToken: 'admin-access',
      sid: 'admin-sid',
      impersonatedBy: null,
    });
    const { req, res } = post('b4m_rt=cust-sid.cust-secret; b4m_rt_admin=admin-sid.admin-secret');

    await handler(req as any, res as any);

    expect(res.getHeader('Set-Cookie')).toBeUndefined();
    // The admin still gets a working access token, and the parked cookie survives for a retry.
    expect(res._getJSONData()).toMatchObject({ accessToken: 'admin-access', impersonating: false });
  });

  it('refuses to revoke a session this admin did not create by impersonating', async () => {
    // The sid comes straight out of a caller-supplied cookie, so without an ownership check any
    // holder of a valid parked return cookie could revoke an arbitrary session by naming its sid.
    mockFindBySid.mockResolvedValue({ sid: 'cust-sid', impersonatedBy: 'a-different-admin' });
    const { req, res } = post('b4m_rt=cust-sid.cust-secret; b4m_rt_admin=admin-sid.admin-secret');

    await handler(req as any, res as any);

    expect(mockRevokeBySid).not.toHaveBeenCalled();
    expect(res._getStatusCode()).toBe(200);
  });

  it('rejects when there is no parked admin session', async () => {
    const { req, res } = post('b4m_rt=cust-sid.cust-secret');

    await expect(handler(req as any, res as any)).rejects.toBeInstanceOf(Error);
    expect(mockRotateSession).not.toHaveBeenCalled();
  });
});

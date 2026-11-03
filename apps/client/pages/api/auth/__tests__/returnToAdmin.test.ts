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
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock('@server/auth/requireNonSystemUser', () => ({ requireNonSystemUser: vi.fn() }));
vi.mock('@server/auth/tokenGenerator', () => ({
  authTokenGenerator: { signAccessToken: vi.fn() },
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  redactUserSecretsForSelf: (user: unknown) => user,
}));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn() }));

const mockRotateSession = vi.fn();
vi.mock('@bike4mind/services', () => ({
  authSessionService: {
    isOpaqueRefreshToken: (t: string) => t.includes('.'),
    parseRefreshToken: (t: string) => (t.includes('.') ? { sid: t.split('.')[0], secret: t.split('.')[1] } : null),
    rotateSession: (...args: any[]) => mockRotateSession(...args),
    endRealtimeConnections: async (
      filter: unknown,
      {
        db,
      }: { db: { realtimeConnections: { endConnections: (filter: unknown) => Promise<{ connectionIds: string[] }> } } }
    ) => {
      // Same contract as the real best-effort wrapper: never throws.
      try {
        return (await db.realtimeConnections.endConnections(filter)).connectionIds;
      } catch {
        return [];
      }
    },
  },
}));

const mockRevokeBySid = vi.fn();
const mockFindBySid = vi.fn();
const mockEndConnections = vi.fn();
const mockUserFindById = vi.fn();
const mockEndImpersonation = vi.fn();
vi.mock('@server/auth/impersonation', () => ({
  endImpersonation: (...args: unknown[]) => mockEndImpersonation(...args),
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...args: any[]) => mockUserFindById(...args) },
  realtimeConnectionRepository: { endConnections: (...args: any[]) => mockEndConnections(...args) },
  authSessionRepository: {
    revokeBySid: (...args: any[]) => mockRevokeBySid(...args),
    findBySid: (...args: any[]) => mockFindBySid(...args),
  },
}));

import handler from '../returnToAdmin';

// Secrets the user document can carry. The redactor is stubbed to identity at the top of this file, so the
// response schema alone is what has to drop them.
const SECRET_USER_FIELDS = {
  password: 'bcrypt_secret_value',
  passwordHash: 'hash_secret_value',
  oauthCredentials: { github: 'ghp_secret_value' },
  securityQuestions: [{ question: 'first pet', answer: 'mittens' }],
  loginRecords: [{ ip: '203.0.113.7' }],
  authProviders: [{ id: 'goog-sub-1', strategy: 'google', accessToken: 'ya29.secret_value' }],
  googleDrive: { accessToken: 'gd_secret_value', refreshToken: 'gd_refresh_value', expiresAt: 123 },
  mfa: { totpEnabled: true, secret: 'totp_secret_value', backupCodes: ['backup_secret_value'] },
  notInSchema: 'undeclared_secret_value',
};
const SECRET_VALUES = [
  'bcrypt_secret_value',
  'hash_secret_value',
  'ghp_secret_value',
  'mittens',
  '203.0.113.7',
  'ya29.secret_value',
  'gd_secret_value',
  'gd_refresh_value',
  'totp_secret_value',
  'backup_secret_value',
  'undeclared_secret_value',
];

function expectUserStrippedOfSecrets(responseBody: { user: Record<string, unknown> }) {
  const { user } = responseBody;
  expect(user).toMatchObject({ id: 'user-1' });
  for (const key of [
    'password',
    'passwordHash',
    'oauthCredentials',
    'securityQuestions',
    'loginRecords',
    'notInSchema',
  ]) {
    expect(user).not.toHaveProperty(key);
  }
  expect(user.authProviders).toEqual([{ id: 'goog-sub-1', strategy: 'google' }]);
  expect(user.googleDrive).toEqual({ expiresAt: 123 });
  expect(user.mfa).toEqual({ totpEnabled: true });
  const serialized = JSON.stringify(responseBody);
  for (const secret of SECRET_VALUES) expect(serialized).not.toContain(secret);
}

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
    mockEndConnections.mockResolvedValue({ connectionIds: [] });
    mockEndImpersonation.mockResolvedValue(undefined);
    mockUserFindById.mockResolvedValue({ id: 'cust-1', name: 'Customer', username: 'customer' });
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
    mockFindBySid.mockResolvedValue({ sid: 'cust-sid', userId: 'cust-1', impersonatedBy: 'admin-1' });
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

  it('returns a user stripped of every secret and undeclared field', async () => {
    mockRotateSession.mockResolvedValue({
      status: 'rotated',
      user: { id: 'user-1', ...SECRET_USER_FIELDS },
      userId: 'admin-1',
      accessToken: 'admin-access',
      refreshToken: 'admin-refresh-rotated',
      sid: 'admin-sid',
      impersonatedBy: null,
    });
    const { req, res } = post('b4m_rt=cust-sid.cust-secret; b4m_rt_admin=admin-sid.admin-secret');

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expectUserStrippedOfSecrets(res._getJSONData());
  });

  it('revokes the impersonation session so the abandoned customer token cannot be refreshed later', async () => {
    const { req, res } = post('b4m_rt=cust-sid.cust-secret; b4m_rt_admin=admin-sid.admin-secret');

    await handler(req as any, res as any);

    expect(mockRevokeBySid).toHaveBeenCalledWith('cust-sid');
    expect(mockEndConnections).toHaveBeenCalledWith({ sid: 'cust-sid' });
  });

  it('still returns the admin to safety when ending the impersonation realtime connections fails', async () => {
    mockEndConnections.mockRejectedValue(new Error('prune failed'));
    const { req, res } = post('b4m_rt=cust-sid.cust-secret; b4m_rt_admin=admin-sid.admin-secret');

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
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

  describe('impersonation end audit', () => {
    const cookie = 'b4m_rt=cust-sid.cust-secret; b4m_rt_admin=admin-sid.admin-secret';

    it('records user.impersonation.ended as the restored admin when the rotation succeeded', async () => {
      mockRotateSession.mockResolvedValue({
        status: 'rotated',
        user: { id: 'admin-1', username: 'admin', name: 'Admin', isAdmin: true },
        userId: 'admin-1',
        accessToken: 'admin-access',
        refreshToken: 'admin-refresh-rotated',
        sid: 'admin-sid',
        impersonatedBy: null,
      });
      const { req, res } = post(cookie);

      await handler(req as any, res as any);

      expect(mockEndImpersonation).toHaveBeenCalledWith(
        req,
        'cust-sid',
        expect.objectContaining({ userId: 'admin-1' })
      );
    });

    it('delegates concurrent end idempotence to the durable lifecycle helper', async () => {
      mockRotateSession.mockResolvedValue({
        status: 'coalesced',
        user: { id: 'admin-1' },
        userId: 'admin-1',
        accessToken: 'admin-access',
        sid: 'admin-sid',
        impersonatedBy: null,
      });
      const { req, res } = post(cookie);

      await handler(req as any, res as any);

      expect(mockEndImpersonation).toHaveBeenCalledWith(
        req,
        'cust-sid',
        expect.objectContaining({ userId: 'admin-1' })
      );
    });

    it('binds durable cleanup to the restored admin even for a foreign session cookie', async () => {
      mockFindBySid.mockResolvedValue({ sid: 'cust-sid', userId: 'cust-1', impersonatedBy: 'a-different-admin' });
      const { req, res } = post(cookie);

      await handler(req as any, res as any);

      expect(mockEndImpersonation).toHaveBeenCalledWith(
        req,
        'cust-sid',
        expect.objectContaining({ userId: 'admin-1' })
      );
    });

    it('records nothing when there is no impersonation cookie to name a session', async () => {
      const { req, res } = post('b4m_rt_admin=admin-sid.admin-secret');

      await handler(req as any, res as any);

      expect(mockEndImpersonation).not.toHaveBeenCalled();
    });
  });
});

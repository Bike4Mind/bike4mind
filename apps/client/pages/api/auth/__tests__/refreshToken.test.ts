import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const {
  mockRotateSession,
  mockIssueSession,
  mockIsOpaque,
  mockFindById,
  mockVerifyRefreshToken,
  mockSetCookie,
  mockRevokeSession,
} = vi.hoisted(() => ({
  mockRevokeSession: vi.fn(),
  mockRotateSession: vi.fn(),
  mockIssueSession: vi.fn(),
  mockIsOpaque: vi.fn(),
  mockFindById: vi.fn(),
  mockVerifyRefreshToken: vi.fn(),
  mockSetCookie: vi.fn(),
}));

// Middleware is stripped so the handler body runs directly.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { use: () => chain, post: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/checkBlockedIP', () => ({ checkBlockedIP: vi.fn() }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: vi.fn() }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn() }));
vi.mock('@server/auth/sessionDevice', () => ({ buildSessionDevice: () => ({}) }));
vi.mock('@bike4mind/server-utils/auth/refreshCookie', () => ({
  readRefreshCookie: () => 'cookie-refresh-token',
  readAdminReturnCookie: () => null,
  setRefreshCookie: (...a: unknown[]) => mockSetCookie(...a),
}));
vi.mock('@server/auth/tokenGenerator', () => ({
  authTokenGenerator: {
    signAccessToken: vi.fn(),
    verifyRefreshToken: (...a: unknown[]) => mockVerifyRefreshToken(...a),
  },
}));
vi.mock('@bike4mind/database', () => ({
  User: { findById: (...a: unknown[]) => mockFindById(...a) },
  userRepository: {},
  authSessionRepository: {},
  realtimeConnectionRepository: {},
}));
vi.mock('@bike4mind/database/infra', () => ({
  secretRotationRepository: { findByKeyNameWithSecret: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    isTokenVersionCurrent: () => true,
    authSessionService: {
      isOpaqueRefreshToken: (...a: unknown[]) => mockIsOpaque(...a),
      rotateSession: (...a: unknown[]) => mockRotateSession(...a),
      issueSession: (...a: unknown[]) => mockIssueSession(...a),
      revokeSession: (...a: unknown[]) => mockRevokeSession(...a),
    },
    // The real account-state rule, so a state a stand-in copy could not express (a suspension)
    // is actually exercised instead of silently passing.
    userService: { accountBlockReasons: actual.userService.accountBlockReasons },
  };
});

vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  redactUserSecretsForSelf: (user: unknown) => user,
}));

import handler from '../refreshToken';
import { logAuthAudit } from '@server/utils/authAudit';

const USER = { id: 'user-1', tokenVersion: 3, isBanned: false, disputePending: false };

// Secrets the user document can carry. The redactor is stubbed to identity above, so the
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

function fire() {
  const { req, res } = createMocks({ method: 'POST', body: {} });
  // any: node-mocks-http mocks aren't structurally the Express Request/Response types.
  (req as any).logger = { log: vi.fn(), warn: vi.fn() };
  return { req: req as any, res: res as any };
}

describe('POST /api/auth/refreshToken - account state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRotateSession.mockResolvedValue({
      status: 'rotated',
      sid: 'sid-1',
      user: USER,
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    });
    mockIssueSession.mockResolvedValue({ accessToken: 'migrated-access', refreshToken: 'migrated-refresh' });
    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-1', tokenVersion: 3 });
    mockFindById.mockResolvedValue(USER);
  });

  describe('session-store refresh token', () => {
    beforeEach(() => mockIsOpaque.mockReturnValue(true));

    it('rotates for a usable account', async () => {
      const { req, res } = fire();
      await handler(req, res);

      expect(mockRevokeSession).not.toHaveBeenCalled();
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().accessToken).toBe('new-access');
      expect(mockSetCookie).toHaveBeenCalledWith(res, 'new-refresh');
    });

    it('forwards the service audit event, metadata included, to the audit log', async () => {
      mockRotateSession.mockImplementation(async (_token: string, opts: { audit: (e: unknown) => unknown }) => {
        await opts.audit({
          type: 'session_reuse_revoked',
          sid: 'sid-1',
          userId: 'user-1',
          metadata: { reason: 'unrecognized_secret', issuedIp: '198.51.100.1' },
        });
        return { status: 'rotated', sid: 'sid-1', user: USER, accessToken: 'a', refreshToken: 'r' };
      });
      const { req, res } = fire();
      await handler(req, res);

      expect(logAuthAudit).toHaveBeenCalledWith(req, {
        userId: 'user-1',
        event: 'session_reuse_revoked',
        metadata: { reason: 'unrecognized_secret', issuedIp: '198.51.100.1', sid: 'sid-1' },
      });
    });

    it('returns a user stripped of every secret and undeclared field', async () => {
      mockRotateSession.mockResolvedValue({
        status: 'rotated',
        sid: 'sid-1',
        user: { ...USER, ...SECRET_USER_FIELDS },
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
      });
      const { req, res } = fire();
      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expectUserStrippedOfSecrets(res._getJSONData());
    });

    it.each([
      ['banned', { isBanned: true }, 'User not found or banned'],
      ['dispute-suspended', { disputePending: true }, 'pending dispute'],
      ['content-suspended', { moderation: { status: 'suspended' } }, 'content-policy'],
    ])('refuses a %s account, revokes the rotated session and hands back no token', async (_label, state, message) => {
      mockRotateSession.mockResolvedValue({
        status: 'rotated',
        sid: 'sid-1',
        user: { ...USER, ...state },
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
      });
      const { req, res } = fire();

      await expect(handler(req, res)).rejects.toThrow(message);
      expect(mockSetCookie).not.toHaveBeenCalled();
      // Rotation already advanced the row; leaving it would strand the client at the recovery cap.
      expect(mockRevokeSession).toHaveBeenCalledWith('sid-1', expect.anything());
    });
  });

  describe('legacy JWT refresh token', () => {
    beforeEach(() => mockIsOpaque.mockReturnValue(false));

    it('migrates a usable account onto a session', async () => {
      const { req, res } = fire();
      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(mockIssueSession).toHaveBeenCalledTimes(1);
    });

    it('returns a user stripped of every secret and undeclared field', async () => {
      mockFindById.mockResolvedValue({ ...USER, ...SECRET_USER_FIELDS });
      const { req, res } = fire();
      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expectUserStrippedOfSecrets(res._getJSONData());
    });

    it('refuses a banned account before minting a session', async () => {
      mockFindById.mockResolvedValue({ ...USER, isBanned: true });
      const { req, res } = fire();

      await expect(handler(req, res)).rejects.toThrow('User not found or banned');
      expect(mockIssueSession).not.toHaveBeenCalled();
      expect(mockSetCookie).not.toHaveBeenCalled();
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockRotateSession, mockIssueSession, mockIsOpaque, mockFindById, mockVerifyRefreshToken, mockSetCookie } =
  vi.hoisted(() => ({
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
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: vi.fn() }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn() }));
vi.mock('@server/auth/sessionDevice', () => ({ buildSessionDevice: () => ({}) }));
vi.mock('@server/auth/refreshCookie', () => ({
  readRefreshCookie: () => 'cookie-refresh-token',
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
}));
vi.mock('@bike4mind/database/infra', () => ({
  secretRotationRepository: { findByKeyNameWithSecret: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@bike4mind/services', () => ({
  isTokenVersionCurrent: () => true,
  authSessionService: {
    isOpaqueRefreshToken: (...a: unknown[]) => mockIsOpaque(...a),
    rotateSession: (...a: unknown[]) => mockRotateSession(...a),
    issueSession: (...a: unknown[]) => mockIssueSession(...a),
  },
  // Stand-in for accountState.accountBlockReasons, which assertAccountStateUsable reads.
  userService: {
    accountBlockReasons: (user: { isBanned?: boolean; disputePending?: boolean }) => [
      ...(user.isBanned ? ['banned'] : []),
      ...(user.disputePending ? ['disputePending'] : []),
    ],
  },
}));

import handler from '../refreshToken';

const USER = { id: 'user-1', tokenVersion: 3, isBanned: false, disputePending: false };

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

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().accessToken).toBe('new-access');
      expect(mockSetCookie).toHaveBeenCalledWith(res, 'new-refresh');
    });

    it.each([
      ['banned', { isBanned: true }, 'User not found or banned'],
      ['dispute-suspended', { disputePending: true }, 'pending dispute'],
    ])('refuses a %s account and hands back no token', async (_label, state, message) => {
      mockRotateSession.mockResolvedValue({
        status: 'rotated',
        user: { ...USER, ...state },
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
      });
      const { req, res } = fire();

      await expect(handler(req, res)).rejects.toThrow(message);
      expect(mockSetCookie).not.toHaveBeenCalled();
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

    it('refuses a banned account before minting a session', async () => {
      mockFindById.mockResolvedValue({ ...USER, isBanned: true });
      const { req, res } = fire();

      await expect(handler(req, res)).rejects.toThrow('User not found or banned');
      expect(mockIssueSession).not.toHaveBeenCalled();
      expect(mockSetCookie).not.toHaveBeenCalled();
    });
  });
});

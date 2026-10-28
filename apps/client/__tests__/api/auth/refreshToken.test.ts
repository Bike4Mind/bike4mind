import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Mock baseApi to unwrap the handler function (idiom from rotate-token.test.ts).
// The builder must be chainable: the handler now does .use(...).use(...).post(fn).
vi.mock('@server/middlewares/baseApi', () => {
  const builder: any = { use: () => builder, post: (fn: any) => fn };
  return { baseApi: () => builder };
});

// Pass-through the auth middlewares so importing the handler doesn't pull their real
// transitive chains (rateLimit -> @bike4mind/utils -> Bedrock -> @bike4mind/common), which
// would break the minimal @bike4mind/common mock below. The baseApi mock ignores .use()
// args anyway, so these only need to exist to satisfy the import.
vi.mock('@server/middlewares/checkBlockedIP', () => ({
  checkBlockedIP: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: any, _res: any, next: any) => next(),
}));

// Real kill-switch comparison so the test exercises the actual enforcement,
// not a stub. (The helper itself is unit-tested in AuthTokenGeneratorService.test.ts.)
// These tests use legacy JWT refresh tokens, which take the non-opaque branch:
// verify -> tokenVersion check -> lazily migrate onto a session via issueSession.
const mockIssueSession = vi.fn();
const mockIsOpaque = vi.fn(() => false);
const mockRotateSession = vi.fn();
vi.mock('@bike4mind/services', () => ({
  isTokenVersionCurrent: (payloadVersion?: number, userVersion?: number) =>
    (payloadVersion ?? 0) === (userVersion ?? 0),
  authSessionService: {
    isOpaqueRefreshToken: (...args: any[]) => mockIsOpaque(...(args as [])),
    rotateSession: (...args: any[]) => mockRotateSession(...args),
    issueSession: (...args: any[]) => mockIssueSession(...args),
    revokeSession: vi.fn(),
    parseRefreshToken: (t: string) => ({ sid: t.split('.')[0], secret: t.split('.')[1] }),
  },
  // Stand-in for accountState.accountBlockReasons, which assertAccountStateUsable reads.
  userService: { accountBlockReasons: () => [] },
}));

const mockFindById = vi.fn();
const mockFindBySid = vi.fn();
vi.mock('@bike4mind/database', () => ({
  realtimeConnectionRepository: { endConnections: vi.fn().mockResolvedValue({ connectionIds: [] }) },
  User: {
    findById: (...args: any[]) => mockFindById(...args),
  },
  userRepository: {},
  authSessionRepository: { findBySid: (...args: unknown[]) => mockFindBySid(...args) },
}));

vi.mock('@bike4mind/database/infra', () => ({
  secretRotationRepository: {
    findByKeyNameWithSecret: vi.fn().mockResolvedValue(null),
  },
}));

// dayjs stub - keeps previousSecret undefined (no recent rotation)
vi.mock('@bike4mind/common', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/common')>('@bike4mind/common');
  return {
    ...actual,
    dayjs: () => ({
      isAfter: () => false,
      subtract: () => ({}),
    }),
    redactUserSecretsForSelf: (user: unknown) => user,
  };
});

vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  UnauthorizedError: class UnauthorizedError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'UnauthorizedError';
    }
  },
}));

const mockVerifyRefreshToken = vi.fn();
vi.mock('@server/auth/tokenGenerator', () => ({
  authTokenGenerator: {
    verifyRefreshToken: (...args: any[]) => mockVerifyRefreshToken(...args),
    signAccessToken: vi.fn(),
  },
}));

import handler from '../../../pages/api/auth/refreshToken';

describe('POST /api/auth/refreshToken — tokenVersion kill switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueSession.mockResolvedValue({ accessToken: 'new_access', refreshToken: 'new_refresh', sid: 'sid' });
  });

  it('rejects a refresh token whose embedded version is stale', async () => {
    // Refresh token carries version 3, but the user has been bumped to 5.
    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-1', tokenVersion: 3 });
    mockFindById.mockResolvedValue({ id: 'user-1', tokenVersion: 5 });

    const { req, res } = createMocks({ method: 'POST', body: { refresh_token: 'stale-token' } });

    await expect(handler(req as any, res as any)).rejects.toThrow('Invalid refresh token');
    expect(mockIssueSession).not.toHaveBeenCalled();
  });

  it('accepts a refresh token whose version matches and migrates onto a session with the current version', async () => {
    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-1', tokenVersion: 5 });
    mockFindById.mockResolvedValue({ id: 'user-1', tokenVersion: 5 });

    const { req, res } = createMocks({ method: 'POST', body: { refresh_token: 'fresh-token' } });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect(mockIssueSession).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ createdVia: 'legacy-migration', tokenVersion: 5 }),
      expect.anything()
    );
  });

  it('treats a legacy refresh token (no embedded version) as valid against a v0 user', async () => {
    // No tokenVersion in the token (issued before the field existed) normalizes to 0.
    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-1', tokenVersion: undefined });
    mockFindById.mockResolvedValue({ id: 'user-1', tokenVersion: 0 });

    const { req, res } = createMocks({ method: 'POST', body: { refresh_token: 'legacy-token' } });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect(mockIssueSession).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ tokenVersion: 0 }),
      expect.anything()
    );
  });

  it('rejects legacy impersonation tokens rather than migrating without a fixed deadline', async () => {
    mockVerifyRefreshToken.mockReturnValue({ userId: 'customer-1', tokenVersion: 0, impersonatedBy: 'admin-9' });
    mockFindById.mockResolvedValue({ id: 'customer-1', tokenVersion: 0 });

    const { req, res } = createMocks({ method: 'POST', body: { refresh_token: 'impersonated-token' } });

    await expect(handler(req as never, res as never)).rejects.toThrow(
      'Legacy support session expired. Return to admin.'
    );
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockIssueSession).not.toHaveBeenCalled();
    expect(res.getHeader('Set-Cookie')).toBeUndefined();
  });
});

describe('POST /api/auth/refreshToken — cookie vs body transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueSession.mockResolvedValue({ accessToken: 'new_access', refreshToken: 'new_refresh', sid: 'sid' });
    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-1', tokenVersion: 0 });
    mockFindById.mockResolvedValue({ id: 'user-1', tokenVersion: 0 });
  });

  const cookieHeader = (res: any) => String(res.getHeader('Set-Cookie') ?? '');

  it('reads the token from the HttpOnly cookie when the body has none, and rotates it back there', async () => {
    const { req, res } = createMocks({ method: 'POST', body: {}, headers: { cookie: 'b4m_rt=cookie-token' } });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect(mockVerifyRefreshToken).toHaveBeenCalledWith('cookie-token', undefined);
    expect(cookieHeader(res)).toContain('b4m_rt=new_refresh');
    // Never in the body: a page script must not be able to read it.
    expect(res._getJSONData().refreshToken).toBeUndefined();
  });

  it('returns the rotated token in the BODY and sets no cookie for a CLI/OAuth caller', async () => {
    const { req, res } = createMocks({ method: 'POST', body: { refresh_token: 'cli-token' } });

    await handler(req as any, res as any);

    expect(res._getJSONData().refreshToken).toBe('new_refresh');
    expect(res.getHeader('Set-Cookie')).toBeUndefined();
  });

  it('strips keys that are not part of the self-view user from the response body', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', tokenVersion: 0, notAUserField: 'leak' });
    const { req, res } = createMocks({ method: 'POST', body: { refresh_token: 'cli-token' } });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().user).not.toHaveProperty('notAUserField');
  });

  it('migrates a pre-cookie browser session onto the cookie when it opts in with cookie: true', async () => {
    // The one-shot upgrade path: the token still lives in localStorage, so it arrives in the body,
    // but the response must move it to a cookie rather than logging the user out.
    const { req, res } = createMocks({ method: 'POST', body: { token: 'legacy-localstorage-token', cookie: true } });

    await handler(req as any, res as any);

    expect(mockVerifyRefreshToken).toHaveBeenCalledWith('legacy-localstorage-token', undefined);
    expect(cookieHeader(res)).toContain('b4m_rt=new_refresh');
    expect(res._getJSONData().refreshToken).toBeUndefined();
  });

  it('prefers an explicit body token over the cookie (a CLI request carrying a stale browser cookie)', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      body: { refresh_token: 'body-token' },
      headers: { cookie: 'b4m_rt=cookie-token' },
    });

    await handler(req as any, res as any);

    expect(mockVerifyRefreshToken).toHaveBeenCalledWith('body-token', undefined);
  });

  it('rejects when neither transport carries a token', async () => {
    const { req, res } = createMocks({ method: 'POST', body: {} });

    await expect(handler(req as any, res as any)).rejects.toThrow('Refresh token is required');
  });
});

/**
 * The session-store branch. A browser has one cookie jar, so the endpoint must never emit a refresh
 * token it did not just mint - otherwise a concurrent sibling's token is overwritten by a stale one
 * and that client is revoked as a thief at its next refresh.
 */
describe('POST /api/auth/refreshToken - opaque token rotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOpaque.mockReturnValue(true);
  });

  const rotated = {
    status: 'rotated' as const,
    user: { id: 'user-1' },
    accessToken: 'access-1',
    refreshToken: 'sid.rotated-secret',
    impersonatedBy: null,
  };
  const coalesced = {
    status: 'coalesced' as const,
    user: { id: 'user-1' },
    accessToken: 'access-1',
    impersonatedBy: null,
  };

  it('sets the rotated token as the cookie when this call advanced the chain', async () => {
    mockRotateSession.mockResolvedValue(rotated);
    const { req, res } = createMocks({ method: 'POST', body: {}, headers: { cookie: 'b4m_rt=sid.old-secret' } });

    await handler(req as any, res as any);

    expect(String(res.getHeader('Set-Cookie'))).toContain('b4m_rt=sid.rotated-secret');
    expect(res._getJSONData().accessToken).toBe('access-1');
  });

  describe('bare-name cookie over https', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.useFakeTimers({ now: new Date('2026-10-25T00:00:00Z') });
      mockRotateSession.mockResolvedValue(rotated);
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    });

    const refresh = async () => {
      const { req, res } = createMocks({ method: 'POST', body: {}, headers: { cookie: 'b4m_rt=sid.old-secret' } });
      const outcome = await handler(req as never, res as never).then(
        () => null,
        (err: unknown) => err
      );
      return { res, outcome, cookies: [res.getHeader('Set-Cookie') ?? []].flat().map(String) };
    };

    it('moves a session created before the cutoff onto the prefixed cookie and expires the bare one', async () => {
      mockFindBySid.mockResolvedValue({ sid: 'sid', createdAt: new Date('2026-10-01T00:00:00Z') });

      const { res, outcome, cookies } = await refresh();

      expect(outcome).toBeNull();
      expect(res._getStatusCode()).toBe(200);
      expect(mockFindBySid).toHaveBeenCalledWith('sid');
      expect(cookies.some(c => c.startsWith('__Host-b4m_rt=sid.rotated-secret; Path=/;') && c.includes('Secure'))).toBe(
        true
      );
      expect(cookies.some(c => c.startsWith('b4m_rt=; Path=/api;') && c.includes('Max-Age=0'))).toBe(true);
    });

    it('rejects a bare-name cookie whose session was created after the cutoff', async () => {
      mockFindBySid.mockResolvedValue({ sid: 'sid', createdAt: new Date('2026-10-31T00:00:00Z') });

      const { outcome, cookies } = await refresh();

      expect(outcome).toMatchObject({ name: 'UnauthorizedError' });
      expect(mockRotateSession).not.toHaveBeenCalled();
      expect(cookies.some(c => c.startsWith('__Host-b4m_rt='))).toBe(false);
    });

    it('rejects a bare-name cookie whose session no longer exists', async () => {
      mockFindBySid.mockResolvedValue(null);

      const { outcome, cookies } = await refresh();

      expect(outcome).toMatchObject({ name: 'UnauthorizedError' });
      expect(mockRotateSession).not.toHaveBeenCalled();
      expect(cookies.some(c => c.startsWith('__Host-b4m_rt='))).toBe(false);
    });

    it('rejects a bare-name cookie once the acceptance window has closed', async () => {
      vi.setSystemTime(new Date('2026-11-30T00:00:00Z'));
      mockFindBySid.mockResolvedValue({ sid: 'sid', createdAt: new Date('2026-10-01T00:00:00Z') });

      const { outcome, cookies } = await refresh();

      expect(outcome).toMatchObject({ name: 'UnauthorizedError' });
      expect(mockRotateSession).not.toHaveBeenCalled();
      expect(cookies).toHaveLength(0);
    });
  });

  it('sets NO cookie when a concurrent sibling already advanced the chain', async () => {
    mockRotateSession.mockResolvedValue(coalesced);
    const { req, res } = createMocks({ method: 'POST', body: {}, headers: { cookie: 'b4m_rt=sid.old-secret' } });

    await handler(req as any, res as any);

    // The winner's Set-Cookie must be the only one in play; overwriting it with the secret we were
    // handed would put the jar a generation behind and strand this browser.
    expect(res.getHeader('Set-Cookie')).toBeUndefined();
    // The caller still gets what it actually needed: a working access token.
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().accessToken).toBe('access-1');
  });

  it('omits refreshToken from a body-transport response when the chain was not advanced', async () => {
    // RFC 6749 s6: an absent refresh_token means "keep the one you have", never "you have none".
    mockRotateSession.mockResolvedValue(coalesced);
    const { req, res } = createMocks({ method: 'POST', body: { refresh_token: 'sid.old-secret' } });

    await handler(req as any, res as any);

    expect(res._getJSONData()).not.toHaveProperty('refreshToken');
    expect(res._getJSONData().accessToken).toBe('access-1');
  });
});

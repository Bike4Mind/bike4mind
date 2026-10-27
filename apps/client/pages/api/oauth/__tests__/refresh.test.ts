import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/oauth/refresh gates on the same first-party client allowlist as the
 * device routes, and on account state like the browser refresh. Rotation itself has
 * its own coverage in the auth-session service.
 */

const USABLE_USER = { id: 'user-1', isBanned: false, disputePending: false };

const h = vi.hoisted(() => ({
  isOpaqueRefreshToken: vi.fn(() => true),
  rotateSession: vi.fn(),
  issueSession: vi.fn(),
  revokeSession: vi.fn(),
  findById: vi.fn(),
  findBySid: vi.fn(),
  verifyRefreshToken: vi.fn(),
  assertAccess: vi.fn(),
  logger: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {
      use: () => chain,
      post: (fn: (req: unknown, res: unknown) => unknown) => (req: unknown, res: unknown) => fn(req, res),
    };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@server/auth/tokenGenerator', () => ({
  ACCESS_TOKEN_TTL_SECONDS: 1800,
  authTokenGenerator: { signAccessToken: vi.fn(() => 'a.jwt'), verifyRefreshToken: h.verifyRefreshToken },
}));
vi.mock('@server/auth/sessionDevice', () => ({ buildSessionDevice: () => ({}) }));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    isTokenVersionCurrent: () => true,
    authSessionService: {
      isOpaqueRefreshToken: h.isOpaqueRefreshToken,
      parseRefreshToken: () => ({ sid: 'sid-1', secret: 'secret' }),
      rotateSession: h.rotateSession,
      issueSession: h.issueSession,
      revokeSession: h.revokeSession,
    },
    // The real account-state rule, so a state a stand-in copy could not express (a suspension)
    // is actually exercised instead of silently passing.
    userService: { accountBlockReasons: actual.userService.accountBlockReasons },
  };
});
vi.mock('@bike4mind/database', () => ({
  realtimeConnectionRepository: { endConnections: vi.fn().mockResolvedValue({ connectionIds: [] }) },
  User: { findById: h.findById },
  userRepository: { findById: h.findById },
  authSessionRepository: { findBySid: h.findBySid },
}));
vi.mock('@server/utils/apiKeyAccessGate', () => ({
  API_KEY_ACCESS_DENIED_MESSAGE: 'API keys require an active paid subscription',
  assertApiKeyAccessAllowed: h.assertAccess,
}));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn() }));

import handler from '../refresh';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';

type Res = {
  statusCode: number;
  body?: { access_token?: string; error?: string };
  status: (c: number) => Res;
  json: (b: unknown) => Res;
};
function mockRes(): Res {
  const res = { statusCode: 200 } as Res;
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b as Res['body'];
    return res;
  };
  return res;
}

const call = (clientId: unknown) => {
  const res = mockRes();
  const req = {
    body: { grant_type: 'refresh_token', refresh_token: 'opaque', client_id: clientId },
    logger: h.logger,
  };
  return (handler as unknown as (req: unknown, res: Res) => Promise<unknown>)(req, res).then(() => res);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.assertAccess.mockReset().mockResolvedValue(undefined);
  h.isOpaqueRefreshToken.mockReturnValue(true);
  h.rotateSession.mockResolvedValue({
    status: 'rotated',
    sid: 'sid-1',
    user: USABLE_USER,
    accessToken: 'a.jwt',
    refreshToken: 'r2.jwt',
  });
  h.issueSession.mockResolvedValue({ accessToken: 'migrated.jwt', refreshToken: 'migrated-r' });
  h.verifyRefreshToken.mockReturnValue({ userId: 'user-1', tokenVersion: 0 });
  h.findById.mockResolvedValue(USABLE_USER);
  h.findBySid.mockResolvedValue({ userId: USABLE_USER.id });
});

describe('POST /api/oauth/refresh client allowlist', () => {
  it('still refreshes for b4m-cli', async () => {
    const res = await call('b4m-cli');

    expect(res.statusCode).toBe(200);
    expect(res.body?.access_token).toBe('a.jwt');
  });

  it('refreshes for b4m-desktop', async () => {
    const res = await call('b4m-desktop');

    expect(res.statusCode).toBe(200);
    expect(res.body?.access_token).toBe('a.jwt');
  });

  it('rejects a client_id that is not on the allowlist', async () => {
    await expect(call('b4m-rogue')).rejects.toThrow();
    expect(h.rotateSession).not.toHaveBeenCalled();
  });
});

describe('POST /api/oauth/refresh account state', () => {
  it.each([
    ['banned', { isBanned: true }, 401],
    ['dispute-suspended', { disputePending: true }, 403],
    ['content-suspended', { moderation: { status: 'suspended' } }, 403],
  ])('refuses a %s account, revokes the rotated session and returns no tokens', async (_label, state, status) => {
    h.rotateSession.mockResolvedValue({
      status: 'rotated',
      sid: 'sid-1',
      user: { ...USABLE_USER, ...state },
      accessToken: 'a.jwt',
      refreshToken: 'r2.jwt',
    });

    const res = await call('b4m-cli');

    expect(res.statusCode).toBe(status);
    expect(res.body?.access_token).toBeUndefined();
    expect(h.revokeSession).toHaveBeenCalledWith('sid-1', expect.anything());
  });

  it('refuses a banned account on a legacy token before minting a session', async () => {
    h.isOpaqueRefreshToken.mockReturnValue(false);
    h.findById.mockResolvedValue({ ...USABLE_USER, isBanned: true });

    const res = await call('b4m-cli');

    expect(res.statusCode).toBe(401);
    expect(h.issueSession).not.toHaveBeenCalled();
  });

  it('still migrates a usable account on a legacy token', async () => {
    h.isOpaqueRefreshToken.mockReturnValue(false);

    const res = await call('b4m-cli');

    expect(res.statusCode).toBe(200);
    expect(res.body?.access_token).toBe('migrated.jwt');
  });
});

describe('POST /api/oauth/refresh API access policy', () => {
  it.each(['b4m-cli', 'b4m-desktop'])('refuses a rotated %s session after access is revoked', async clientId => {
    h.assertAccess.mockRejectedValueOnce(new ForbiddenError('API keys require an active paid subscription'));
    const res = await call(clientId);
    expect(res.statusCode).toBe(403);
    expect(res.body?.access_token).toBeUndefined();
    expect(res.body?.error).toBe('subscription_required');
    expect(h.rotateSession).not.toHaveBeenCalled();
    expect(h.assertAccess).toHaveBeenCalledWith(USABLE_USER, undefined, expect.anything());
  });

  it('refuses a legacy refresh before minting a replacement session', async () => {
    h.isOpaqueRefreshToken.mockReturnValue(false);
    h.assertAccess.mockRejectedValueOnce(new ForbiddenError('API keys require an active paid subscription'));
    const res = await call('b4m-cli');
    expect(res.statusCode).toBe(403);
    expect(h.issueSession).not.toHaveBeenCalled();
  });

  it('preserves device client provenance when migrating a legacy refresh token', async () => {
    h.isOpaqueRefreshToken.mockReturnValue(false);
    await call('b4m-desktop');
    expect(h.issueSession).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ clientId: 'b4m-desktop' }),
      expect.anything()
    );
  });

  it('rejects an unknown session before rotating', async () => {
    h.findBySid.mockResolvedValueOnce(null);
    const res = await call('b4m-cli');
    expect(res.statusCode).toBe(401);
    expect(h.rotateSession).not.toHaveBeenCalled();
  });

  it('preserves the refresh chain when reading session provenance fails', async () => {
    h.findBySid.mockRejectedValueOnce(Object.assign(new Error('database unavailable'), { name: 'MongoNetworkError' }));
    const res = await call('b4m-cli');
    expect(res.statusCode).toBe(503);
    expect(res.body?.error).toBe('temporarily_unavailable');
    expect(h.rotateSession).not.toHaveBeenCalled();
    expect(res.body?.access_token).toBeUndefined();
  });

  it('returns a retryable server error rather than bad credentials when the access lookup fails', async () => {
    h.assertAccess.mockRejectedValueOnce(new Error('subscription database down'));
    const res = await call('b4m-cli');
    expect(res.statusCode).toBe(500);
    expect(res.body?.error).toBe('temporarily_unavailable');
    expect(res.body?.access_token).toBeUndefined();
    expect(h.rotateSession).not.toHaveBeenCalled();
  });
});

describe('POST /api/oauth/refresh error logging', () => {
  it('logs a subscription_required refusal as a warning, not an error', async () => {
    h.assertAccess.mockRejectedValueOnce(new ForbiddenError('API keys require an active paid subscription'));
    const res = await call('b4m-cli');
    expect(res.statusCode).toBe(403);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('403'));
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('logs an invalid refresh token as a warning', async () => {
    h.findBySid.mockResolvedValueOnce(null);
    const res = await call('b4m-cli');
    expect(res.statusCode).toBe(401);
    expect(h.logger.warn).toHaveBeenCalled();
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('still logs a server-side failure as an error', async () => {
    h.assertAccess.mockRejectedValueOnce(new Error('subscription database down'));
    const res = await call('b4m-cli');
    expect(res.statusCode).toBe(500);
    expect(h.logger.error).toHaveBeenCalled();
    expect(h.logger.warn).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/oauth/refresh gates on the same first-party client allowlist as the
 * device routes. Only that gate is exercised here; rotation itself has its own
 * coverage in the auth-session service.
 */

const h = vi.hoisted(() => ({
  isOpaqueRefreshToken: vi.fn(() => true),
  rotateSession: vi.fn(async () => ({ status: 'rotated', accessToken: 'a.jwt', refreshToken: 'r2.jwt' })),
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
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@server/auth/tokenGenerator', () => ({
  ACCESS_TOKEN_TTL_SECONDS: 1800,
  authTokenGenerator: { signAccessToken: vi.fn(() => 'a.jwt'), verifyRefreshToken: vi.fn() },
}));
vi.mock('@server/auth/sessionDevice', () => ({ buildSessionDevice: () => ({}) }));
vi.mock('@bike4mind/services', () => ({
  isTokenVersionCurrent: () => true,
  authSessionService: {
    isOpaqueRefreshToken: h.isOpaqueRefreshToken,
    rotateSession: h.rotateSession,
    issueSession: vi.fn(),
  },
}));
vi.mock('@bike4mind/database', () => ({
  User: { findById: vi.fn() },
  userRepository: {},
  authSessionRepository: {},
}));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn() }));

import handler from '../refresh';

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
    logger: { error: vi.fn() },
  };
  return (handler as unknown as (req: unknown, res: Res) => Promise<unknown>)(req, res).then(() => res);
};

describe('POST /api/oauth/refresh client allowlist', () => {
  beforeEach(() => vi.clearAllMocks());

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

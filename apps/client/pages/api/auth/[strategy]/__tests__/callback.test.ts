import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Middleware: collapse the baseApi chain so `.get(fn)` yields the raw handler,
// mirroring apps/client/pages/api/auth/okta/__tests__/callback.test.ts.
vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = { use: () => chain, get: (fn: any) => fn };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/checkBlockedIP', () => ({
  checkBlockedIP: () => (_req: any, _res: any, next: any) => next?.(),
}));

// passport.authenticate is invoked as passport.authenticate(strategy, opts, cb)(req, res, next);
// the mock lets each test drive the (err, user, info) triple passport would normally supply.
const mockAuthenticate = vi.fn();
vi.mock('passport', () => ({
  default: { authenticate: (...args: any[]) => mockAuthenticate(...args) },
}));

const mockAuthFailCreate = vi.fn();
vi.mock('@bike4mind/database', () => ({
  authFailLogRepository: { create: (...a: any[]) => mockAuthFailCreate(...a) },
}));

vi.mock('@server/auth/tokenGenerator', () => ({
  authTokenGenerator: {
    createAccessToken: () => ({ accessToken: 'jwt-access', refreshToken: 'jwt-refresh' }),
  },
}));
vi.mock('@server/auth/jwtStateStore', () => ({ verifyStateToken: vi.fn() }));
vi.mock('@server/auth/authSuccessRedirect', () => ({ authSuccessRedirectQuery: () => '' }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn().mockResolvedValue(undefined) }));

// Import after mocks are registered.
import handler from '@pages/api/auth/[strategy]/callback';

function makeReqRes() {
  const { req, res } = createMocks({
    method: 'GET',
    query: { strategy: 'github', state: 'state-token' },
    headers: { host: 'localhost:3000', 'user-agent': 'vitest' },
    url: '/api/auth/github/callback',
  });
  return { req: req as any, res: res as any };
}

/** Drive the handler as if passport's verify callback resolved with (err, user, info). */
async function runCallback(err: unknown, user: unknown, info: unknown) {
  mockAuthenticate.mockImplementation(
    (_strategy: string, _opts: any, cb: any) => (req: any, res: any, next: any) => cb(err, user, info)
  );
  const { req, res } = makeReqRes();
  await handler(req, res, vi.fn());
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('[strategy]/callback - !user branch sanitized reason', () => {
  it('maps a thrown E11000 duplicate-key error to duplicate_account and never leaks the raw Mongo text or embedded victim email', async () => {
    const rawMongoText = 'E11000 duplicate key error dup key: { username: "victim@example.com" }';
    const res = await runCallback(null, undefined, { code: 'duplicate_account', message: rawMongoText });

    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'duplicate_account' }));
    const loggedArg = mockAuthFailCreate.mock.calls[0][0];
    expect(JSON.stringify(loggedArg)).not.toContain('victim@example.com');
    expect(JSON.stringify(loggedArg)).not.toContain('E11000');

    const redirectUrl = res._getRedirectUrl();
    expect(redirectUrl).toBe('/login?error=Authentication%20failed');
    expect(redirectUrl).not.toContain('victim');
    expect(redirectUrl).not.toContain('E11000');
  });

  it('maps state_expired to a distinct canonical reason with a friendly retry redirect', async () => {
    const res = await runCallback(null, undefined, {
      code: 'state_expired',
      message: 'Authorization request expired. Please try again.',
    });

    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'state_expired' }));
    expect(res._getRedirectUrl()).toBe(
      `/login?error=${encodeURIComponent('Your login request expired. Please try again.')}`
    );
  });

  it('maps state_missing and state_invalid to their own distinct canonical reasons', async () => {
    const missingRes = await runCallback(null, undefined, {
      code: 'state_missing',
      message: 'Missing state parameter',
    });
    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'state_missing' }));
    expect(missingRes._getRedirectUrl()).toBe('/login?error=Authentication%20failed');

    vi.clearAllMocks();

    const invalidRes = await runCallback(null, undefined, {
      code: 'state_invalid',
      message: 'Invalid authorization state.',
    });
    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'state_invalid' }));
    expect(invalidRes._getRedirectUrl()).toBe('/login?error=Authentication%20failed');
  });

  it('default-denies an unrecognized or absent code to internal - raw info.message never substitutes for reason', async () => {
    const withUnknownCode = await runCallback(null, undefined, {
      code: 'some_new_unwhitelisted_code',
      message: 'irrelevant',
    });
    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'internal' }));

    vi.clearAllMocks();

    const withNoInfo = await runCallback(null, undefined, undefined);
    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'internal' }));
    expect(withNoInfo._getRedirectUrl()).toBe('/login?error=Authentication%20failed');
    void withUnknownCode;
  });

  it('maps forbidden_system_user to its own distinct canonical reason', async () => {
    const res = await runCallback(null, undefined, {
      code: 'forbidden_system_user',
      message: 'Cannot authenticate as a system account',
    });

    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'forbidden_system_user' }));
    expect(res._getRedirectUrl()).toBe('/login?error=Authentication%20failed');
  });
});

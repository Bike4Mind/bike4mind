// @vitest-environment node
/** POST /api/auth/desktop-web-session/redeem: the Desktop companion window's first navigation. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  route: undefined as ((req: unknown, res: unknown) => unknown) | undefined,
  baseApiOptions: undefined as unknown,
  redeemDesktopWebSessionCode: vi.fn(),
  issueBrowserSession: vi.fn(),
  readRefreshCookie: vi.fn(),
  findBySid: vi.fn(),
  findById: vi.fn(),
  logSignInSuccess: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions = options;
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.post = (fn: (req: unknown, res: unknown) => unknown) => ((h.route = fn), chain);
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => undefined }));
vi.mock('@bike4mind/server-utils/auth/refreshCookie', () => ({ readRefreshCookie: h.readRefreshCookie }));
vi.mock('@bike4mind/database', () => ({
  authSessionRepository: { findBySid: h.findBySid },
  userRepository: { findById: h.findById },
}));
vi.mock('@bike4mind/services', () => ({
  authSessionService: {
    parseRefreshToken: (token: string) => {
      const [sid, secret] = token.split('.');
      return sid && secret ? { sid, secret } : null;
    },
  },
}));
vi.mock('@server/auth/issueSession', () => ({ issueBrowserSession: h.issueBrowserSession }));
vi.mock('@server/auth/signInSecondFactor', () => ({ logSignInSuccess: h.logSignInSuccess }));
vi.mock('@server/auth/desktopWebSession', () => ({ redeemDesktopWebSessionCode: h.redeemDesktopWebSessionCode }));

await import('../redeem');

const USER_ID = '64b000000000000000000001';
const USER = { id: USER_ID, tokenVersion: 4, isSystem: false };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const HOUR = 60 * 60 * 1000;

async function run(input: { body?: unknown; headers?: Record<string, string> } = {}) {
  const { req, res } = createMocks({
    method: 'POST',
    body: (input.body ?? { code: 'the-code' }) as Record<string, unknown>,
    headers: input.headers ?? { 'sec-fetch-site': 'none', 'content-type': 'application/json' },
  });
  // The route runs on a Next.js request, which has none of the Express helpers node-mocks-http adds.
  Object.assign(req, { logger, is: undefined });
  await h.route!(req, res);
  return res;
}

const expectLanding = (res: Awaited<ReturnType<typeof run>>) => {
  expect(res.statusCode).toBe(303);
  expect(res._getRedirectUrl()).toBe('/notebooks');
};

beforeEach(() => {
  vi.clearAllMocks();
  h.redeemDesktopWebSessionCode.mockResolvedValue({ userId: USER_ID });
  h.readRefreshCookie.mockReturnValue(null);
  h.findById.mockResolvedValue(USER);
  h.issueBrowserSession.mockResolvedValue({ accessToken: 'at', sid: 'web-sid' });
});

describe('POST /api/auth/desktop-web-session/redeem', () => {
  it('is unauthenticated (the code is the credential) and POST-only, so the code never sits in a URL', () => {
    expect(h.baseApiOptions).toMatchObject({ auth: false, allowedMethods: ['POST'] });
  });

  it('issues a browser session for the code owner and lands on notebooks', async () => {
    const res = await run();

    expectLanding(res);
    expect(h.redeemDesktopWebSessionCode).toHaveBeenCalledWith('the-code');
    expect(h.issueBrowserSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), USER_ID, {
      createdVia: 'desktop-handoff',
      tokenVersion: 4,
    });
    expect(res.getHeader('Cache-Control')).toBe('no-store');
    expect(h.logSignInSuccess).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      userId: USER_ID,
      strategy: 'desktop-handoff',
      trustedDevice: null,
    });
  });

  it.each([
    ['a cross-site', { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }],
    ['a same-site', { 'sec-fetch-site': 'same-site', 'content-type': 'application/json' }],
    ['a Fetch-Metadata-less', { 'content-type': 'application/json' }],
    ['a form-encoded', { 'sec-fetch-site': 'none', 'content-type': 'application/x-www-form-urlencoded' }],
    ['a content-type-less', { 'sec-fetch-site': 'none' }],
  ])('refuses %s POST before spending the code (login CSRF)', async (_label, headers) => {
    const res = await run({ headers });

    expect(res.statusCode).toBe(403);
    expect(h.redeemDesktopWebSessionCode).not.toHaveBeenCalled();
    expect(h.issueBrowserSession).not.toHaveBeenCalled();
  });

  it('accepts a JSON body whose content type carries parameters', async () => {
    const res = await run({ headers: { 'sec-fetch-site': 'none', 'content-type': 'Application/JSON; charset=utf-8' } });

    expectLanding(res);
    expect(h.issueBrowserSession).toHaveBeenCalledOnce();
  });

  it('lands without a session when the code is rejected', async () => {
    h.redeemDesktopWebSessionCode.mockResolvedValue(null);
    const res = await run();

    expectLanding(res);
    expect(h.issueBrowserSession).not.toHaveBeenCalled();
  });

  it('lands without spending anything when the body is malformed', async () => {
    const res = await run({ body: { code: 'x', extra: true } });

    expectLanding(res);
    expect(h.redeemDesktopWebSessionCode).not.toHaveBeenCalled();
  });

  it('reuses a live web session the window already holds for the same user', async () => {
    h.readRefreshCookie.mockReturnValue('web-sid.secret');
    h.findBySid.mockResolvedValue({ userId: USER_ID, revokedAt: null, expiresAt: new Date(Date.now() + HOUR) });
    const res = await run();

    expectLanding(res);
    expect(h.findBySid).toHaveBeenCalledWith('web-sid');
    expect(h.issueBrowserSession).not.toHaveBeenCalled();
    expect(h.logSignInSuccess).not.toHaveBeenCalled();
  });

  it.each([
    ['revoked', { userId: USER_ID, revokedAt: new Date(), expiresAt: new Date(Date.now() + HOUR) }],
    ['expired', { userId: USER_ID, revokedAt: null, expiresAt: new Date(Date.now() - 1) }],
    ['another user', { userId: 'someone-else', revokedAt: null, expiresAt: new Date(Date.now() + HOUR) }],
  ])('replaces a held session that is %s', async (_label, session) => {
    h.readRefreshCookie.mockReturnValue('web-sid.secret');
    h.findBySid.mockResolvedValue(session);
    const res = await run();

    expectLanding(res);
    expect(h.issueBrowserSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', null],
    ['a system account', { ...USER, isSystem: true }],
    ['banned', { ...USER, isBanned: true }],
  ])('issues nothing when the account is %s', async (_label, user) => {
    h.findById.mockResolvedValue(user);
    const res = await run();

    expectLanding(res);
    expect(h.issueBrowserSession).not.toHaveBeenCalled();
  });
});

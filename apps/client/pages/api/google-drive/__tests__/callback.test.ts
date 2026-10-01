import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Browser-binding regression for the Google Drive connect callback. A signed state
 * minted in one browser (its nonce cookie) must not complete in another. Guards the
 * silent-disable footgun: if the handler drops readStateNonceHash(req) from its
 * verifyStateToken call, the mismatch cases below start writing tokens and fail.
 *
 * The auth primitive (createStateToken / issueStateNonce / verifyStateToken) is real;
 * only the network token exchange and DB write are stubbed.
 */

// Middleware: collapse the baseApi chain so `.get(fn)` yields the raw handler.
vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = { use: () => chain, get: (fn: any) => fn, post: (fn: any) => fn };
  return { baseApi: () => chain };
});

const mockFindByIdAndUpdate = vi.fn();
vi.mock('@bike4mind/database', () => ({
  User: { findByIdAndUpdate: (...a: any[]) => mockFindByIdAndUpdate(...a) },
  orgGoogleDriveConnectionRepository: {},
}));

vi.mock('@server/security/tokenEncryption', () => ({
  encryptToken: (v: string) => `enc:${v}`,
  decryptToken: (v: string) => v,
}));

vi.mock('@server/utils/config', () => ({
  Config: { JWT_SECRET: 'test-secret', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret' },
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Keep the real state options + auth primitive; stub only the network token exchange.
vi.mock('@server/integrations/google/drive/common', async importOriginal => {
  const actual = await (importOriginal as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    getTokens: vi.fn(async () => ({ access_token: 'at', refresh_token: 'rt', expiry_date: Date.now() + 3_600_000 })),
  };
});

// Import after mocks are registered.
import callbackHandler from '@pages/api/google-drive/callback';
import errorHandler from '@server/middlewares/errorHandler';
import { getTokens } from '@server/integrations/google/drive/common';
import { issueStateNonce, NONCE_SLOT } from '@server/auth/oauthFlowCookie';
import { createStateToken } from '@server/auth/jwtStateStore';
import { GOOGLE_DRIVE_STATE_OPTIONS } from '@server/integrations/google/drive/common';

/** Mint a genuine state token bound to a fresh nonce, returning both the state and the browser's cookie. */
function mintStateWithCookie(userId = 'user-1'): { state: string; nonceCookie: string } {
  const { res } = createMocks();
  const nonceHash = issueStateNonce(res as any, NONCE_SLOT.driveConnect);
  const setCookie = res.getHeader('Set-Cookie');
  const cookieStr = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie);
  const nonceCookie = cookieStr.split(';')[0]; // b4m_oauth_nonce_google-drive=<value>
  const state = createStateToken(GOOGLE_DRIVE_STATE_OPTIONS, { userId }, nonceHash);
  return { state, nonceCookie };
}

beforeEach(() => {
  mockFindByIdAndUpdate.mockReset();
});

/** baseApi is collapsed above, so route a thrown error through errorHandler the way its onError does. */
async function handler(req: any, res: any) {
  req.logger = { warn: vi.fn(), error: vi.fn() };
  try {
    await callbackHandler(req, res);
  } catch (error) {
    errorHandler(error, req, res);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A failed connect must answer a coded 400, never a 401: ApiContext tears the login
 * session down on a code-less 401, and redirectTo then replays this callback forever.
 */
function expectRejectedConnect(res: ReturnType<typeof createMocks>['res'], code: string) {
  expect(res._getStatusCode()).toBe(400);
  expect(res._getJSONData()).toMatchObject({ code });
  expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  expectNonceCleared(res);
}

function expectNonceCleared(res: ReturnType<typeof createMocks>['res']) {
  const setCookie = [res.getHeader('Set-Cookie') ?? []].flat().map(String);
  expect(setCookie).toContainEqual(expect.stringMatching(/^b4m_oauth_nonce_google-drive=;.*Max-Age=0/));
}

describe('google-drive callback browser-binding', () => {
  it('rejects completion from a different browser and writes no tokens', async () => {
    const { state } = mintStateWithCookie();
    const { req, res } = createMocks({
      method: 'GET',
      query: { code: 'auth-code', state },
      headers: { cookie: 'b4m_oauth_nonce_google-drive=someone-elses-nonce' },
    });
    (req as any).user = { id: 'victim' };

    await handler(req as any, res as any);
    expectRejectedConnect(res, 'GOOGLE_DRIVE_CONNECT_INVALID');
  });

  it('rejects when the completing session is not the user that started the flow', async () => {
    const { state, nonceCookie } = mintStateWithCookie('starter');
    const { req, res } = createMocks({
      method: 'GET',
      query: { code: 'auth-code', state },
      headers: { cookie: nonceCookie },
    });
    (req as any).user = { id: 'someone-else' };

    await handler(req as any, res as any);
    expectRejectedConnect(res, 'GOOGLE_DRIVE_CONNECT_INVALID');
  });

  it('rejects when the browser presents no nonce cookie', async () => {
    const { state } = mintStateWithCookie();
    const { req, res } = createMocks({ method: 'GET', query: { code: 'auth-code', state } });
    (req as any).user = { id: 'victim' };

    await handler(req as any, res as any);
    expectRejectedConnect(res, 'GOOGLE_DRIVE_CONNECT_INVALID');
  });

  it('reports an expired consent as expired rather than invalid', async () => {
    vi.useFakeTimers();
    const { state, nonceCookie } = mintStateWithCookie();
    vi.advanceTimersByTime(11 * 60 * 1000);
    const { req, res } = createMocks({
      method: 'GET',
      query: { code: 'auth-code', state },
      headers: { cookie: nonceCookie },
    });
    (req as any).user = { id: 'user-1' };

    await handler(req as any, res as any);
    expectRejectedConnect(res, 'GOOGLE_DRIVE_CONNECT_EXPIRED');
  });

  it('completes when the initiating browser presents its nonce cookie', async () => {
    const { state, nonceCookie } = mintStateWithCookie();
    const { req, res } = createMocks({
      method: 'GET',
      query: { code: 'auth-code', state },
      headers: { cookie: nonceCookie },
    });
    (req as any).user = { id: 'user-1' };

    await handler(req as any, res as any);
    expect(mockFindByIdAndUpdate).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(204);
    expectNonceCleared(res);
  });

  it('answers a coded 400, not the upstream 401, when Google rejects the token exchange', async () => {
    vi.mocked(getTokens).mockRejectedValueOnce(Object.assign(new Error('invalid_client'), { status: 401 }));
    const { state, nonceCookie } = mintStateWithCookie();
    const { req, res } = createMocks({
      method: 'GET',
      query: { code: 'auth-code', state },
      headers: { cookie: nonceCookie },
    });
    (req as any).user = { id: 'user-1' };

    await handler(req as any, res as any);
    expectRejectedConnect(res, 'GOOGLE_DRIVE_CONNECT_FAILED');
  });
});

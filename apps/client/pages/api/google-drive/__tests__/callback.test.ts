import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import handler from '@pages/api/google-drive/callback';
import { issueStateNonce } from '@server/auth/oauthFlowCookie';
import { createStateToken } from '@server/auth/jwtStateStore';
import { GOOGLE_DRIVE_STATE_OPTIONS } from '@server/integrations/google/drive/common';

/** Mint a genuine state token bound to a fresh nonce, returning both the state and the browser's cookie. */
function mintStateWithCookie(): { state: string; nonceCookie: string } {
  const { res } = createMocks();
  const nonceHash = issueStateNonce(res as any);
  const setCookie = res.getHeader('Set-Cookie');
  const cookieStr = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie);
  const nonceCookie = cookieStr.split(';')[0]; // b4m_oauth_nonce=<value>
  const state = createStateToken(GOOGLE_DRIVE_STATE_OPTIONS, undefined, nonceHash);
  return { state, nonceCookie };
}

beforeEach(() => {
  mockFindByIdAndUpdate.mockReset();
});

describe('google-drive callback browser-binding', () => {
  it('rejects completion from a different browser and writes no tokens', async () => {
    const { state } = mintStateWithCookie();
    const { req, res } = createMocks({
      method: 'GET',
      query: { code: 'auth-code', state },
      headers: { cookie: 'b4m_oauth_nonce=someone-elses-nonce' },
    });
    (req as any).user = { id: 'victim' };

    await expect(handler(req as any, res as any)).rejects.toThrow();
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects when the browser presents no nonce cookie', async () => {
    const { state } = mintStateWithCookie();
    const { req, res } = createMocks({ method: 'GET', query: { code: 'auth-code', state } });
    (req as any).user = { id: 'victim' };

    await expect(handler(req as any, res as any)).rejects.toThrow();
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
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
  });
});

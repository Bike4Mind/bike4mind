// @vitest-environment node
/** GET/POST /api/personas/redeem: the single-use login code is the only credential. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { PERSONA_ENDPOINT_OFF_CODE } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  routes: {} as Record<string, (req: unknown, res: unknown) => unknown>,
  settings: { enabled: true },
  redeemPersonaLoginCode: vi.fn(),
  issueBrowserSession: vi.fn(),
  issueSessionForRequest: vi.fn(),
  readRefreshCookie: vi.fn(),
  readAdminReturnCookie: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = (fn: (req: unknown, res: unknown) => unknown) => ((h.routes.GET = fn), chain);
    chain.post = (fn: (req: unknown, res: unknown) => unknown) => ((h.routes.POST = fn), chain);
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => undefined }));
vi.mock('@bike4mind/server-utils/auth/refreshCookie', () => ({
  readRefreshCookie: h.readRefreshCookie,
  readAdminReturnCookie: h.readAdminReturnCookie,
}));
vi.mock('@bike4mind/services', () => ({ authSessionService: { PERSONA_SESSION_IDLE_TTL_MS: 24 * 60 * 60 * 1000 } }));
vi.mock('@server/auth/issueSession', () => ({
  issueBrowserSession: h.issueBrowserSession,
  issueSessionForRequest: h.issueSessionForRequest,
}));
vi.mock('@server/auth/tokenGenerator', () => ({ ACCESS_TOKEN_TTL_SECONDS: 1800 }));
vi.mock('@server/personas/personaAccounts', () => ({
  loadPersonaSettings: async () => h.settings,
  redeemPersonaLoginCode: h.redeemPersonaLoginCode,
}));

await import('../redeem');

const CODE = 'x'.repeat(43);
const PERSONA = {
  id: '64b000000000000000000001',
  username: 'persona-alpha-123',
  email: 'a@x.test',
  tokenVersion: 3,
  personaExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
};
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function fire(method: 'GET' | 'POST', input: { query?: Record<string, string>; body?: unknown } = {}) {
  const { req, res } = createMocks({
    method,
    query: input.query ?? {},
    body: input.body as Record<string, unknown> | undefined,
  });
  Object.assign(req, { logger });
  return { req, res };
}

async function run(method: 'GET' | 'POST', input?: Parameters<typeof fire>[1]) {
  const { req, res } = fire(method, input);
  await h.routes[method](req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.settings = { enabled: true };
  h.redeemPersonaLoginCode.mockResolvedValue(PERSONA);
  h.issueBrowserSession.mockResolvedValue(undefined);
  h.issueSessionForRequest.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt' });
  h.readRefreshCookie.mockReturnValue(undefined);
  h.readAdminReturnCookie.mockReturnValue(undefined);
});

describe('GET /api/personas/redeem', () => {
  it('signs the browser in and redirects 303 to /, with no-store and no-referrer', async () => {
    const res = await run('GET', { query: { code: CODE } });

    expect(res._getStatusCode()).toBe(303);
    expect(res._getRedirectUrl()).toBe('/');
    expect(res.getHeader('Cache-Control')).toBe('no-store');
    expect(res.getHeader('Referrer-Policy')).toBe('no-referrer');
    expect(h.redeemPersonaLoginCode).toHaveBeenCalledWith(CODE, expect.any(Date));
    expect(h.issueBrowserSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      PERSONA.id,
      expect.objectContaining({ createdVia: 'persona-mint', tokenVersion: 3 })
    );
  });

  it.each([
    ['a refresh cookie', () => h.readRefreshCookie.mockReturnValue('rt')],
    ['an admin-return cookie', () => h.readAdminReturnCookie.mockReturnValue('ar')],
  ])('answers 409 on a browser carrying %s, and leaves the code unspent', async (_label, arrange) => {
    arrange();
    const res = await run('GET', { query: { code: CODE } });

    expect(res._getStatusCode()).toBe(409);
    expect(h.redeemPersonaLoginCode).not.toHaveBeenCalled();
    expect(h.issueBrowserSession).not.toHaveBeenCalled();
  });

  it('answers 400 for an invalid, expired or used code, and issues no session', async () => {
    h.redeemPersonaLoginCode.mockResolvedValue(null);
    const res = await run('GET', { query: { code: CODE } });

    expect(res._getStatusCode()).toBe(400);
    expect(h.issueBrowserSession).not.toHaveBeenCalled();
    expect(res.getHeader('Cache-Control')).toBe('no-store');
  });

  it('treats a missing code as invalid', async () => {
    h.redeemPersonaLoginCode.mockResolvedValue(null);
    const res = await run('GET');
    expect(h.redeemPersonaLoginCode).toHaveBeenCalledWith('', expect.any(Date));
    expect(res._getStatusCode()).toBe(400);
  });

  it('answers 404 with the endpoint-off code while PersonaMintEnabled is off', async () => {
    h.settings = { enabled: false };
    const res = await run('GET', { query: { code: CODE } });

    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).toEqual({ error: 'Not found', errorCode: PERSONA_ENDPOINT_OFF_CODE });
    expect(h.redeemPersonaLoginCode).not.toHaveBeenCalled();
  });
});

describe('POST /api/personas/redeem', () => {
  it('returns the persona and a token pair, uncacheable', async () => {
    const res = await run('POST', { body: { code: CODE } });

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      user: { id: PERSONA.id, username: PERSONA.username, email: PERSONA.email, isPersona: true },
      accessToken: 'at',
      accessTokenExpiresInSeconds: 1800,
      refreshToken: 'rt',
    });
    expect(res.getHeader('Cache-Control')).toBe('no-store');
    expect(h.issueSessionForRequest).toHaveBeenCalledWith(
      expect.anything(),
      PERSONA.id,
      expect.objectContaining({ createdVia: 'persona-mint' })
    );
  });

  it('caps the refresh token at the persona expiry when that is sooner than the idle TTL', async () => {
    h.redeemPersonaLoginCode.mockResolvedValue({ ...PERSONA, personaExpiresAt: new Date(Date.now() + 60_000) });
    await run('POST', { body: { code: CODE } });
    const [, , params] = h.issueSessionForRequest.mock.calls[0];
    expect(params.refreshTtlMs).toBeLessThanOrEqual(60_000);
  });

  it.each([
    ['an extra key', { code: CODE, isAdmin: true }],
    ['a non-string code', { code: 5 }],
    ['no code', {}],
    ['a code over 64 characters', { code: 'x'.repeat(65) }],
  ])('answers 400 for a body with %s, without redeeming', async (_label, body) => {
    const res = await run('POST', { body });
    expect(res._getStatusCode()).toBe(400);
    expect(h.redeemPersonaLoginCode).not.toHaveBeenCalled();
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
  });

  it('answers 400 for an invalid, expired or used code', async () => {
    h.redeemPersonaLoginCode.mockResolvedValue(null);
    const res = await run('POST', { body: { code: CODE } });
    expect(res._getStatusCode()).toBe(400);
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
  });

  it('answers 404 with the endpoint-off code while PersonaMintEnabled is off', async () => {
    h.settings = { enabled: false };
    const res = await run('POST', { body: { code: CODE } });
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).toMatchObject({ errorCode: PERSONA_ENDPOINT_OFF_CODE });
    expect(h.redeemPersonaLoginCode).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response } from 'express';

/**
 * POST /api/oauth/end-session (OIDC RP-Initiated Logout). The id_token_hint is checked by the real
 * verifyIdTokenHint against tokens minted by the real generateIdToken; the session store, cookies
 * and audit log are stubbed so each case can assert exactly what was (not) touched.
 */

const h = vi.hoisted(() => ({
  handler: null as null | ((req: Request, res: Response) => Promise<unknown>),
  storedSigningKey: null as null | { secretName: string; encryptedValue: string },
  authenticate: vi.fn(),
  findByClientId: vi.fn(),
  revokeSession: vi.fn(),
  revokeUserSessions: vi.fn(),
  updateLogoutTime: vi.fn(),
  clearSessionCookies: vi.fn(),
  logAuthAudit: vi.fn(),
  logEvent: vi.fn(),
  grants: { revokeGrant: vi.fn(), deleteGrant: vi.fn(), upsertGrant: vi.fn() },
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    post: (fn: (req: Request, res: Response) => Promise<unknown>) => {
      h.handler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { OAUTH_RSA_PRIVATE_KEY: undefined } }));
vi.mock('passport', () => ({ default: { authenticate: h.authenticate } }));
vi.mock('@bike4mind/database', () => ({
  oauthClientRepository: { findByClientId: h.findByClientId },
  oauthAuthorizationCodeRepository: {},
  oauthGrantRepository: h.grants,
  userRepository: {},
  authSessionRepository: {},
  realtimeConnectionRepository: {},
  // A store that keeps the first key written, so the hints below are signed with the key the route verifies.
  systemSecretRepository: {
    findBySecretName: async () => h.storedSigningKey,
    upsertSecret: async (secretName: string, data: { encryptedValue: string }) =>
      (h.storedSigningKey ??= { secretName, encryptedValue: data.encryptedValue }),
  },
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  encryptToken: (value: string) => value,
  decryptStoredSecret: (value: string) => value,
}));
vi.mock('@bike4mind/services', () => ({
  userService: { updateLogoutTime: h.updateLogoutTime, revokeUserSessions: h.revokeUserSessions },
  authSessionService: { revokeSession: h.revokeSession },
}));
vi.mock('@bike4mind/server-utils/auth/refreshCookie', () => ({ clearSessionCookies: h.clearSessionCookies }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: h.logEvent }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: h.logAuthAudit }));
vi.mock('@server/middlewares/apiKeyAuth', () => ({ isApiKeyAuth: () => false }));

import { generateIdToken } from '@server/auth/oauthServer';
import '@pages/api/oauth/end-session';

const CLIENT_ID = 'b4m_example_rp_00000000';
const SIGNED_OUT = 'https://rp.example.test/signed-out';
const CLIENT = { clientId: CLIENT_ID, name: 'Example RP', postLogoutRedirectUris: [SIGNED_OUT] };
const USER = { id: 'user-1', sid: 'sid-1' };

const hintFor = (userId: string, clientId = CLIENT_ID) =>
  generateIdToken({ userId, email: 'u@example.test', name: 'U', clientId, scopes: ['openid'], scopeLimited: true });

/** What the mocked passport.authenticate hands its callback: (err, user), or calls `next` when `viaNext`. */
let session: { err: Error | null; user: unknown; viaNext?: boolean };

async function call(body: Record<string, unknown> | undefined, opts: { bearer?: boolean } = { bearer: true }) {
  const { req, res } = createMocks({
    method: 'POST',
    body,
    headers: opts.bearer === false ? {} : { authorization: 'Bearer browser.token' },
  });
  if (body === undefined) req.body = undefined;
  const logger = { warn: vi.fn() };
  Object.assign(req, { logger });
  await h.handler!(req as unknown as Request, res as unknown as Response);
  return { status: res._getStatusCode(), json: res._getJSONData(), req, logger };
}

const expectSessionUntouched = () => {
  expect(h.clearSessionCookies).not.toHaveBeenCalled();
  expect(h.revokeSession).not.toHaveBeenCalled();
  expect(h.updateLogoutTime).not.toHaveBeenCalled();
  expect(h.logAuthAudit).not.toHaveBeenCalled();
};

const expectSignedOutThisBrowserOnly = () => {
  expect(h.clearSessionCookies).toHaveBeenCalledOnce();
  expect(h.revokeSession).toHaveBeenCalledOnce();
  expect(h.revokeSession).toHaveBeenCalledWith('sid-1', expect.anything());
  expect(h.revokeUserSessions).not.toHaveBeenCalled();
  for (const fn of Object.values(h.grants)) expect(fn).not.toHaveBeenCalled();
  expect(h.logAuthAudit).toHaveBeenCalledWith(expect.anything(), {
    userId: 'user-1',
    event: 'logout',
    metadata: { clientId: CLIENT_ID },
  });
};

beforeAll(() => {
  process.env.APP_URL = 'https://b4m.example.test';
});

beforeEach(() => {
  vi.clearAllMocks();
  h.findByClientId.mockImplementation(async (id: string) => (id === CLIENT_ID ? CLIENT : null));
  session = { err: null, user: USER };
  h.authenticate.mockImplementation(
    (_s: string, _o: unknown, cb: (e: Error | null, u: unknown) => void) =>
      (_req: unknown, _res: unknown, next: () => void) => (session.viaNext ? next() : cb(session.err, session.user))
  );
});

describe('POST /api/oauth/end-session - rejected requests leave the session alone', () => {
  it.each([[{}], [undefined]])('rejects a body without client_id or id_token_hint (%j)', async body => {
    const { status, json } = await call(body);
    expect(status).toBe(400);
    expect(json).toEqual({ error: 'invalid_request', error_description: 'client_id or id_token_hint is required' });
    expectSessionUntouched();
  });

  it.each([
    ['a non-object body', 'client_id=x', 'body is invalid'],
    ['an oversized state', { client_id: CLIENT_ID, state: 'x'.repeat(2049) }, 'state is invalid'],
  ])('names the invalid field for %s', async (_n, body, description) => {
    const { status, json } = await call(body as Record<string, unknown>);
    expect(status).toBe(400);
    expect(json).toEqual({ error: 'invalid_request', error_description: description });
    expectSessionUntouched();
  });

  it('rejects an unknown client', async () => {
    const { status, json } = await call({ client_id: 'b4m_unknown', post_logout_redirect_uri: SIGNED_OUT });
    expect(status).toBe(400);
    expect(json).toEqual({ error: 'invalid_client', error_description: 'Unknown client' });
    expect(json.redirect_to).toBeUndefined();
    expectSessionUntouched();
  });

  it.each([
    ['another site', 'https://evil.example.test/'],
    ['a prefix of the registered URI', 'https://rp.example.test/signed'],
    ['the registered URI with a query', `${SIGNED_OUT}?x=1`],
  ])('rejects a post_logout_redirect_uri for %s', async (_n, uri) => {
    const { status, json } = await call({
      client_id: CLIENT_ID,
      post_logout_redirect_uri: uri,
      id_token_hint: await hintFor('user-1'),
    });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_request');
    expectSessionUntouched();
  });

  it.each([
    ['a malformed hint', 'not-a-jwt'],
    ["another client's hint", 'other-client'],
  ])('rejects %s', async (_n, hint) => {
    const id_token_hint = hint === 'other-client' ? await hintFor('user-1', 'b4m_other_rp_00000000') : hint;
    const { status, json } = await call({ client_id: CLIENT_ID, post_logout_redirect_uri: SIGNED_OUT, id_token_hint });
    expect(status).toBe(400);
    expect(json).toEqual({ error: 'invalid_request', error_description: 'id_token_hint is invalid' });
    expectSessionUntouched();
  });
});

describe('POST /api/oauth/end-session - confirmation', () => {
  it('asks for confirmation without a hint and leaves the session alone', async () => {
    const { status, json } = await call({ client_id: CLIENT_ID, post_logout_redirect_uri: SIGNED_OUT, state: 's1' });
    expect(status).toBe(200);
    expect(json).toEqual({
      status: 'confirmation_required',
      client_name: 'Example RP',
      redirect_to: `${SIGNED_OUT}?state=s1`,
    });
    expectSessionUntouched();
  });

  it('asks for confirmation when a valid hint names another user', async () => {
    const { json } = await call({ client_id: CLIENT_ID, id_token_hint: await hintFor('user-2') });
    expect(json).toEqual({ status: 'confirmation_required', client_name: 'Example RP', redirect_to: null });
    expectSessionUntouched();
  });

  it('signs out once the user confirms', async () => {
    const { json } = await call({ client_id: CLIENT_ID, post_logout_redirect_uri: SIGNED_OUT, confirm: true });
    expect(json).toEqual({ status: 'signed_out', redirect_to: SIGNED_OUT });
    expectSignedOutThisBrowserOnly();
  });
});

describe('POST /api/oauth/end-session - sign-out', () => {
  it('signs out without confirmation when the hint names the signed-in user, appending state', async () => {
    const { status, json, req } = await call({
      client_id: CLIENT_ID,
      post_logout_redirect_uri: SIGNED_OUT,
      state: 'a b&c',
      id_token_hint: await hintFor('user-1'),
    });
    expect(status).toBe(200);
    expect(json).toEqual({ status: 'signed_out', redirect_to: `${SIGNED_OUT}?state=a+b%26c` });
    expect(req.user).toEqual(USER);
    expectSignedOutThisBrowserOnly();
  });

  it('takes the client from the hint when client_id is absent', async () => {
    const { json } = await call({ post_logout_redirect_uri: SIGNED_OUT, id_token_hint: await hintFor('user-1') });
    expect(json).toEqual({ status: 'signed_out', redirect_to: SIGNED_OUT });
    expect(h.findByClientId).toHaveBeenCalledWith(CLIENT_ID);
    expectSignedOutThisBrowserOnly();
  });

  it("rejects a hint-only request for an unknown client's token", async () => {
    const { json } = await call({ id_token_hint: await hintFor('user-1', 'b4m_unknown') });
    expect(json).toEqual({ error: 'invalid_client', error_description: 'Unknown client' });
    expectSessionUntouched();
  });

  it('accepts an expired hint', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const stale = await hintFor('user-1');
    vi.useRealTimers();
    const { json } = await call({ client_id: CLIENT_ID, id_token_hint: stale });
    expect(json).toEqual({ status: 'signed_out', redirect_to: null });
    expectSignedOutThisBrowserOnly();
  });
});

describe('POST /api/oauth/end-session - no Bike4Mind session', () => {
  it.each([
    ['no Authorization header', { bearer: false }, () => undefined],
    ['a token passport rejects', { bearer: true }, () => (session = { err: null, user: false })],
    ['a passport error', { bearer: true }, () => (session = { err: new Error('boom'), user: false })],
    ['passport falling through to next', { bearer: true }, () => (session = { err: null, user: false, viaNext: true })],
    [
      'a relying-party OAuth access token',
      { bearer: true },
      () => (session = { err: null, user: { ...USER, oauthGrant: { scopes: ['openid'] } } }),
    ],
  ])('still redirects, changing nothing, with %s', async (_n, opts, arrange) => {
    arrange();
    const { status, json } = await call(
      { client_id: CLIENT_ID, post_logout_redirect_uri: SIGNED_OUT, state: 's', confirm: true },
      opts
    );
    expect(status).toBe(200);
    expect(json).toEqual({ status: 'signed_out', redirect_to: `${SIGNED_OUT}?state=s` });
    expectSessionUntouched();
  });

  it('logs a passport verify error', async () => {
    session = { err: new Error('boom'), user: false };
    const { logger } = await call({ client_id: CLIENT_ID });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

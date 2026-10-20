import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';

/**
 * Provider-side hardening for POST /api/oauth/token (authorization_code grant):
 * confidential clients MUST authenticate with their secret, and public clients
 * MUST use PKCE. These pin both halves and the downgrade case a challenge-less
 * code must not be redeemable without either credential.
 *
 * baseApi/rateLimit are stubbed to pass-through so the exported handler is the
 * raw (req, res) function; only the oauthServer / repository / session seams are
 * mocked.
 */

const h = vi.hoisted(() => ({
  validateClient: vi.fn(),
  validateClientSecret: vi.fn(),
  verifyPkce: vi.fn(),
  generateIdToken: vi.fn(() => 'id.jwt'),
  findValidCode: vi.fn(),
  consumeValidCode: vi.fn(),
  findById: vi.fn(),
  issueSessionForRequest: vi.fn(async () => ({ accessToken: 'a.jwt', refreshToken: 'r.jwt' })),
  findGrant: vi.fn(),
  signAccessToken: vi.fn(() => 'oauth.jwt'),
  grantCovers: vi.fn(() => true),
  oauthAccessTokenAudience: vi.fn(() => 'https://app.example'),
  findByClientId: vi.fn(),
  verifyClientSecret: vi.fn(),
  findByFamilyId: vi.fn(),
  rotate: vi.fn(),
  revokeFamily: vi.fn(),
  mintRefreshFamily: vi.fn(async () => 'fam1.secret0'),
  assertAccountStateUsable: vi.fn(),
  tryIncrement: vi.fn(),
  logAuthAudit: vi.fn(),
  rateLimitOptions: null as null | {
    limit: (req: unknown) => number;
    subject?: (req: unknown) => string | undefined;
  },
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
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (opts: NonNullable<typeof h.rateLimitOptions>) => {
    h.rateLimitOptions = opts;
    return () => undefined;
  },
}));
vi.mock('@server/utils/ip', () => ({ getClientIp: () => '203.0.113.7' }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: h.logAuthAudit }));
vi.mock('@server/auth/oauthServer', () => ({
  validateClient: h.validateClient,
  validateClientSecret: h.validateClientSecret,
  verifyPkce: h.verifyPkce,
  generateIdToken: h.generateIdToken,
}));
vi.mock('@bike4mind/database', () => ({
  oauthAuthorizationCodeRepository: { findValidCode: h.findValidCode, consumeValidCode: h.consumeValidCode },
  userRepository: { findById: h.findById },
  oauthGrantRepository: { findGrant: h.findGrant },
  oauthClientRepository: { findByClientId: h.findByClientId, verifyClientSecret: h.verifyClientSecret },
  oauthRefreshTokenRepository: { findByFamilyId: h.findByFamilyId, rotate: h.rotate, revokeFamily: h.revokeFamily },
  cacheRepository: { tryIncrementWithinLimitFixedWindow: h.tryIncrement },
}));
// Deterministic stand-ins for the pure token-format helpers (the real ones are pinned in
// oauthRefreshToken.test.ts): hash(s) = 'h:' + s, and every new secret is 'secret1'.
vi.mock('@bike4mind/services', () => ({
  isTokenVersionCurrent: (a?: number, b?: number) => (a ?? 0) === (b ?? 0),
  authSessionService: {
    parseRefreshToken: (t: string) => {
      const [sid, secret] = t.split('.');
      return sid && secret ? { sid, secret } : null;
    },
    hashRefreshSecret: (s: string) => `h:${s}`,
    generateRefreshSecret: () => 'secret1',
    buildRefreshToken: (sid: string, secret: string) => `${sid}.${secret}`,
  },
}));
vi.mock('@server/auth/oauthRefreshToken', () => ({
  mintRefreshFamily: h.mintRefreshFamily,
  refreshFamilyExpiresAt: () => new Date('2030-01-01T00:00:00Z'),
}));
vi.mock('@server/auth/assertAccountStateUsable', () => ({ assertAccountStateUsable: h.assertAccountStateUsable }));
vi.mock('@server/auth/issueSession', () => ({ issueSessionForRequest: h.issueSessionForRequest }));
vi.mock('@server/auth/tokenGenerator', () => ({
  ACCESS_TOKEN_TTL_SECONDS: 3600,
  authTokenGenerator: { signAccessToken: h.signAccessToken },
}));
vi.mock('@server/auth/oauthConsent', () => ({
  grantCovers: h.grantCovers,
  oauthAccessTokenAudience: h.oauthAccessTokenAudience,
}));

import handler from '../token';

type Res = {
  statusCode: number;
  body?: {
    error?: string;
    error_description?: string;
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    scope?: string;
  };
  headers: Record<string, unknown>;
  status: (c: number) => Res;
  json: (b: unknown) => Res;
  setHeader: (k: string, v: unknown) => void;
};
function mockRes(): Res {
  const res = { statusCode: 200, headers: {} } as Res;
  res.setHeader = (k: string, v: unknown) => {
    res.headers[k] = v;
  };
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

const call = (body: Record<string, unknown>) => {
  const res = mockRes();
  const logger = { warn: vi.fn(), info: vi.fn() };
  return (handler as unknown as (req: unknown, res: Res) => Promise<unknown>)({ body, logger }, res).then(() =>
    Object.assign(res, {
      oauthLines: logger.warn.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[OAUTH_ERROR]')),
    })
  );
};

const baseBody = {
  grant_type: 'authorization_code',
  code: 'the-code',
  redirect_uri: 'https://app.example/cb',
  client_id: 'client-1',
};

// A grammar-valid PKCE verifier (RFC 7636 Appendix B example: 43 unreserved chars). verifyPkce is
// mocked in this suite, so only the request-schema grammar check sees this value.
const VALID_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

const authCode = (codeChallenge: string) => ({
  clientId: 'client-1',
  redirectUri: 'https://app.example/cb',
  codeChallenge,
  scopes: ['openid'],
  userId: 'u1',
});

// The handler now reads the code (findValidCode) to validate it, then atomically consumes it
// (consumeValidCode) only once validation passes. A happy path needs both to resolve the code.
const seedValidCode = (ac: ReturnType<typeof authCode>) => {
  (h.findValidCode as Mock).mockResolvedValue(ac);
  (h.consumeValidCode as Mock).mockResolvedValue(ac);
};

describe('POST /api/oauth/token authorization_code hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (h.findById as Mock).mockResolvedValue({ id: 'u1', email: 'u@x.com', username: 'u', tokenVersion: 0 });
  });

  it('rejects a confidential client that omits its secret (401 invalid_client)', async () => {
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'client_secret_post' });

    const res = await call({ ...baseBody });

    expect(res.statusCode).toBe(401);
    expect(res.body?.error).toBe('invalid_client');
    expect(h.consumeValidCode).not.toHaveBeenCalled();
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
  });

  it('rejects a confidential client that presents a bad secret (401 invalid_client)', async () => {
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'client_secret_post' });
    (h.validateClientSecret as Mock).mockResolvedValue(null);

    const res = await call({ ...baseBody, client_secret: 'wrong' });

    expect(res.statusCode).toBe(401);
    expect(res.body?.error).toBe('invalid_client');
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
  });

  it('lets a confidential client with a valid secret exchange a PKCE-less code', async () => {
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'client_secret_post' });
    (h.validateClientSecret as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'client_secret_post' });
    seedValidCode(authCode(''));

    const res = await call({ ...baseBody, client_secret: 'right' });

    expect(res.body?.access_token).toBe('a.jwt');
    expect(h.issueSessionForRequest).toHaveBeenCalledOnce();
  });

  it('still verifies a recorded challenge for a confidential client (no verifier -> 400 invalid_grant)', async () => {
    // A confidential client that authenticated by secret is not exempt from PKCE when a challenge
    // was recorded at authorization. Narrowing the `if (authCode.codeChallenge)` verify to public
    // clients only would let this exchange through; it must not.
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'client_secret_post' });
    (h.validateClientSecret as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'client_secret_post' });
    (h.findValidCode as Mock).mockResolvedValue(authCode('challenge'));

    const res = await call({ ...baseBody, client_secret: 'right' });

    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('invalid_grant');
    expect(h.verifyPkce).not.toHaveBeenCalled();
    // The code is NOT burned: validation failed before the atomic consume.
    expect(h.consumeValidCode).not.toHaveBeenCalled();
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
  });

  it('rejects a public client redeeming a challenge-less code (downgrade -> 400 invalid_grant)', async () => {
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'none' });
    (h.findValidCode as Mock).mockResolvedValue(authCode(''));

    const res = await call({ ...baseBody });

    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('invalid_grant');
    expect(res.body?.error_description).toMatch(/pkce required/i);
    expect(h.consumeValidCode).not.toHaveBeenCalled();
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
  });

  it('rejects a public client whose verifier does not match the challenge (400 invalid_grant)', async () => {
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'none' });
    (h.findValidCode as Mock).mockResolvedValue(authCode('challenge'));
    (h.verifyPkce as Mock).mockReturnValue(false);

    const res = await call({ ...baseBody, code_verifier: VALID_VERIFIER });

    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('invalid_grant');
    expect(h.consumeValidCode).not.toHaveBeenCalled();
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
  });

  it('lets a public client with a matching verifier complete PKCE', async () => {
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'none' });
    seedValidCode(authCode('challenge'));
    (h.verifyPkce as Mock).mockReturnValue(true);

    const res = await call({ ...baseBody, code_verifier: VALID_VERIFIER });

    expect(res.body?.access_token).toBe('a.jwt');
    expect(h.issueSessionForRequest).toHaveBeenCalledOnce();
  });

  it('rejects a code_verifier outside RFC 7636 grammar at the boundary (400 invalid_request), never hashing it', async () => {
    // The verifier is constrained to 43-128 unreserved chars in the request schema, so a
    // low-entropy verifier (recoverable offline from the exposed challenge) is rejected before
    // verifyPkce ever hashes it. Boundary lengths: 42 and 129 fail; an in-range value with an
    // out-of-set char fails.
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'none' });
    seedValidCode(authCode('challenge'));

    for (const bad of ['a'.repeat(42), 'a'.repeat(129), 'a'.repeat(42) + '!']) {
      const res = await call({ ...baseBody, code_verifier: bad });
      expect(res.statusCode).toBe(400);
      expect(res.body?.error).toBe('invalid_request');
    }
    expect(h.verifyPkce).not.toHaveBeenCalled();
    expect(h.consumeValidCode).not.toHaveBeenCalled();
  });

  it('accepts a boundary-length code_verifier (43 and 128 unreserved chars) at the schema', async () => {
    // The valid ends of the range must pass the schema and reach verifyPkce (mocked true here).
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'none' });
    (h.verifyPkce as Mock).mockReturnValue(true);

    for (const ok of ['a'.repeat(43), 'a'.repeat(128)]) {
      seedValidCode(authCode('challenge'));
      const res = await call({ ...baseBody, code_verifier: ok });
      expect(res.body?.access_token).toBe('a.jwt');
    }
  });

  it('does NOT burn the code on a client_id/redirect_uri mismatch (consume deferred until validation passes)', async () => {
    // The mismatched redemption is rejected, but the code is only READ, never consumed, so the
    // legitimate client can still redeem it. (Reverses the earlier burn-on-mismatch behavior per the
    // review on token.ts:64.)
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'none' });
    (h.findValidCode as Mock).mockResolvedValue(authCode('challenge'));

    const res = await call({ ...baseBody, client_id: 'client-2' });

    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('invalid_grant');
    expect(res.body?.error_description).toMatch(/mismatch/i);
    expect(h.consumeValidCode).not.toHaveBeenCalled();
  });

  it('rejects a lost consume race even after validation passes (single-use preserved)', async () => {
    // Validation passes but consumeValidCode returns null - a concurrent request already claimed the
    // code between the read and the atomic consume. Must reject rather than issue a second token.
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'none' });
    (h.findValidCode as Mock).mockResolvedValue(authCode('challenge'));
    (h.consumeValidCode as Mock).mockResolvedValue(null);
    (h.verifyPkce as Mock).mockReturnValue(true);

    const res = await call({ ...baseBody, code_verifier: VALID_VERIFIER });

    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('invalid_grant');
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
  });

  it('mints a first-party id_token as NOT scope-limited (full claims even for scope=openid)', async () => {
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'none' });
    seedValidCode(authCode('challenge'));
    (h.verifyPkce as Mock).mockReturnValue(true);

    await call({ ...baseBody, code_verifier: VALID_VERIFIER });

    expect(h.generateIdToken).toHaveBeenCalledWith(expect.objectContaining({ scopeLimited: false }));
  });
});

/**
 * The relying-party issuance path (token.ts kind:'oauth' branch). Without these the branch never
 * executes under test, so a regression dropping kind:'oauth' - which would hand a relying party a
 * full first-party-shaped session - would pass CI green.
 */
describe('POST /api/oauth/token relying-party issuance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (h.findById as Mock).mockResolvedValue({ id: 'u1', email: 'u@x.com', username: 'u', tokenVersion: 0 });
    (h.grantCovers as Mock).mockReturnValue(true);
    (h.signAccessToken as Mock).mockReturnValue('oauth.jwt');
  });

  const relyingPartyExchange = async () => {
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'none', clientType: 'relying-party' });
    seedValidCode(authCode('challenge'));
    (h.verifyPkce as Mock).mockReturnValue(true);
    return call({ ...baseBody, code_verifier: VALID_VERIFIER });
  };

  it('issues a kind:oauth access token with no refresh_token and echoes the granted scope', async () => {
    (h.findGrant as Mock).mockResolvedValue({ scopes: ['openid'] });

    const res = (await relyingPartyExchange()) as Res & {
      body?: { access_token?: string; refresh_token?: string; scope?: string; id_token?: string };
    };

    // The oauth access token, minted via signAccessToken with kind:'oauth' - not a first-party session.
    expect(res.body?.access_token).toBe('oauth.jwt');
    expect(res.body?.refresh_token).toBeUndefined();
    expect(res.body?.scope).toBe('openid');
    expect(h.signAccessToken).toHaveBeenCalledWith('u1', 0, expect.objectContaining({ kind: 'oauth' }));
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
    // The id_token for a relying party IS scope-limited.
    expect(h.generateIdToken).toHaveBeenCalledWith(expect.objectContaining({ scopeLimited: true }));
  });

  it('refuses to issue when no covering consent grant is recorded (400 access_denied)', async () => {
    (h.findGrant as Mock).mockResolvedValue(null);

    const res = await relyingPartyExchange();

    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('access_denied');
    expect(h.signAccessToken).not.toHaveBeenCalled();
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
  });

  it('refuses to issue when a grant exists but does not cover the requested scopes (400 access_denied)', async () => {
    // Exercises the grantCovers(...) === false branch: without this case grantCovers is mocked true
    // everywhere, so deleting the coverage re-check would not fail CI.
    (h.findGrant as Mock).mockResolvedValue({ scopes: ['openid'] });
    (h.grantCovers as Mock).mockReturnValue(false);

    const res = await relyingPartyExchange();

    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('access_denied');
    expect(h.signAccessToken).not.toHaveBeenCalled();
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
  });

  it('issues a refresh_token when the code carries offline_access', async () => {
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'none', clientType: 'relying-party' });
    seedValidCode({ ...authCode('challenge'), scopes: ['openid', 'offline_access'] });
    (h.verifyPkce as Mock).mockReturnValue(true);
    (h.findGrant as Mock).mockResolvedValue({ scopes: ['openid', 'offline_access'] });

    const res = await call({ ...baseBody, code_verifier: VALID_VERIFIER });

    expect(res.body?.refresh_token).toBe('fam1.secret0');
    expect(h.mintRefreshFamily).toHaveBeenCalledWith({
      userId: 'u1',
      clientId: 'client-1',
      scopes: ['openid', 'offline_access'],
      tokenVersion: 0,
    });
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
  });
});

describe('POST /api/oauth/token refresh_token grant', () => {
  const SCOPES = ['openid', 'email', 'offline_access'];
  const rp = { clientId: 'client-1', clientType: 'relying-party', tokenEndpointAuthMethod: 'none' };
  const family = (overrides: Record<string, unknown> = {}) => ({
    familyId: 'fam1',
    userId: 'u1',
    clientId: 'client-1',
    scopes: SCOPES,
    tokenHash: 'h:secret0',
    tokenVersion: 0,
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    createdAt: new Date(),
    ...overrides,
  });
  const refreshBody = { grant_type: 'refresh_token', refresh_token: 'fam1.secret0', client_id: 'client-1' };

  beforeEach(() => {
    vi.clearAllMocks();
    (h.findByClientId as Mock).mockResolvedValue(rp);
    (h.assertAccountStateUsable as Mock).mockImplementation(() => undefined);
    (h.findByFamilyId as Mock).mockResolvedValue(family());
    (h.rotate as Mock).mockImplementation(async () => family({ tokenHash: 'h:secret1' }));
    (h.findById as Mock).mockResolvedValue({ id: 'u1', email: 'u@x.com', username: 'u', tokenVersion: 0 });
    (h.findGrant as Mock).mockResolvedValue({ scopes: SCOPES });
    (h.grantCovers as Mock).mockReturnValue(true);
    (h.signAccessToken as Mock).mockReturnValue('oauth.jwt');
    (h.tryIncrement as Mock).mockResolvedValue({ success: true, expiresAt: new Date(Date.now() + 60_000) });
  });

  const expectRejected = (res: Res, error = 'invalid_grant') => {
    expect(res.body?.error).toBe(error);
    expect(res.body?.access_token).toBeUndefined();
    expect(h.signAccessToken).not.toHaveBeenCalled();
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
  };

  it('rotates and returns a kind:oauth access token, a no-nonce scope-limited id_token and the next refresh token', async () => {
    const res = await call(refreshBody);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      access_token: 'oauth.jwt',
      id_token: 'id.jwt',
      refresh_token: 'fam1.secret1',
      scope: SCOPES.join(' '),
    });
    expect(h.rotate).toHaveBeenCalledWith(
      'fam1',
      expect.objectContaining({ expectedHash: 'h:secret0', nextHash: 'h:secret1' })
    );
    expect(h.signAccessToken).toHaveBeenCalledWith(
      'u1',
      0,
      expect.objectContaining({ kind: 'oauth', client_id: 'client-1', scope: SCOPES.join(' ') })
    );
    const idTokenParams = (h.generateIdToken as Mock).mock.calls[0][0];
    expect(idTokenParams).toMatchObject({ scopeLimited: true, scopes: SCOPES });
    expect(idTokenParams.nonce).toBeUndefined();
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
  });

  it('treats a superseded token as reuse: revokes the family and rejects', async () => {
    // The family has already rotated past secret0.
    (h.findByFamilyId as Mock).mockResolvedValue(family({ tokenHash: 'h:secret1' }));

    const res = await call(refreshBody);

    expectRejected(res);
    expect(h.revokeFamily).toHaveBeenCalledWith('fam1');
    expect(h.rotate).not.toHaveBeenCalled();
    expect(h.logAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'u1',
        event: 'oauth_refresh_reuse_revoked',
        metadata: { clientId: 'client-1', familyId: 'fam1' },
      })
    );
  });

  it('rejects even the newest token once the family is revoked', async () => {
    (h.findByFamilyId as Mock).mockResolvedValue(family({ tokenHash: 'h:secret1', revokedAt: new Date() }));

    expectRejected(await call({ ...refreshBody, refresh_token: 'fam1.secret1' }));
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('treats a lost rotate race as reuse and revokes the family', async () => {
    (h.rotate as Mock).mockResolvedValue(null);

    expectRejected(await call(refreshBody));
    expect(h.revokeFamily).toHaveBeenCalledWith('fam1');
    expect(h.logAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: 'oauth_refresh_reuse_revoked' })
    );
  });

  it('rejects an expired family', async () => {
    (h.findByFamilyId as Mock).mockResolvedValue(family({ expiresAt: new Date(Date.now() - 1000) }));

    expectRejected(await call(refreshBody));
  });

  it('rejects a revoked grant without consuming the token', async () => {
    (h.findGrant as Mock).mockResolvedValue(null);

    expectRejected(await call(refreshBody));
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('rejects a grant that no longer includes offline_access', async () => {
    (h.findGrant as Mock).mockResolvedValue({ scopes: ['openid', 'email'] });
    (h.grantCovers as Mock).mockImplementation((granted: string[], requested: string[]) =>
      requested.every(s => granted.includes(s))
    );

    expectRejected(await call(refreshBody));
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('rejects after a tokenVersion bump', async () => {
    (h.findById as Mock).mockResolvedValue({ id: 'u1', email: 'u@x.com', tokenVersion: 1 });

    expectRejected(await call(refreshBody));
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('rejects a blocked account', async () => {
    (h.assertAccountStateUsable as Mock).mockImplementation(() => {
      throw new Error('banned');
    });

    expectRejected(await call(refreshBody));
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('rejects a deactivated client (findByClientId filters isActive)', async () => {
    (h.findByClientId as Mock).mockResolvedValue(null);

    const res = await call(refreshBody);

    expect(res.statusCode).toBe(401);
    expectRejected(res, 'invalid_client');
  });

  it('rejects a different client_id than the family was issued to, without revoking it', async () => {
    (h.findByClientId as Mock).mockResolvedValue({ ...rp, clientId: 'client-2' });

    expectRejected(await call({ ...refreshBody, client_id: 'client-2' }));
    expect(h.revokeFamily).not.toHaveBeenCalled();
  });

  it('requires a valid client_secret from a confidential client (401)', async () => {
    (h.findByClientId as Mock).mockResolvedValue({ ...rp, tokenEndpointAuthMethod: 'client_secret_post' });
    (h.verifyClientSecret as Mock).mockResolvedValue(null);

    for (const body of [refreshBody, { ...refreshBody, client_secret: 'wrong' }]) {
      const res = await call(body);
      expect(res.statusCode).toBe(401);
      expectRejected(res, 'invalid_client');
    }
    expect(h.findByFamilyId).not.toHaveBeenCalled();
  });

  it('never gives a first-party client a session through the refresh_token grant', async () => {
    (h.findByClientId as Mock).mockResolvedValue({ ...rp, clientType: 'first-party' });

    expectRejected(await call(refreshBody), 'unauthorized_client');
    expect(h.findByFamilyId).not.toHaveBeenCalled();
  });

  it('narrows the response to a requested subset of scopes', async () => {
    const res = await call({ ...refreshBody, scope: 'openid' });

    expect(res.body?.scope).toBe('openid');
    expect(h.signAccessToken).toHaveBeenCalledWith('u1', 0, expect.objectContaining({ scope: 'openid' }));
    expect(h.generateIdToken).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['openid'] }));
  });

  it('rejects a scope wider than the family with invalid_scope, without consuming the token', async () => {
    expectRejected(await call({ ...refreshBody, scope: 'openid files:write' }), 'invalid_scope');
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('rejects a body without a refresh_token as invalid_request', async () => {
    const res = await call({ grant_type: 'refresh_token', client_id: 'client-1' });

    expect(res.statusCode).toBe(400);
    expectRejected(res, 'invalid_request');
    expect(h.findByClientId).not.toHaveBeenCalled();
  });

  it('rejects a malformed refresh token without a family lookup or revoke', async () => {
    expectRejected(await call({ ...refreshBody, refresh_token: 'no-dot' }));
    expect(h.findByFamilyId).not.toHaveBeenCalled();
    expect(h.revokeFamily).not.toHaveBeenCalled();
  });

  it('rejects an unknown family without revoking anything', async () => {
    (h.findByFamilyId as Mock).mockResolvedValue(null);

    expectRejected(await call(refreshBody));
    expect(h.revokeFamily).not.toHaveBeenCalled();
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('rejects a family whose user no longer exists, without consuming the token', async () => {
    (h.findById as Mock).mockResolvedValue(null);

    expectRejected(await call(refreshBody));
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('refreshes for a confidential client that presents a valid client_secret', async () => {
    (h.findByClientId as Mock).mockResolvedValue({ ...rp, tokenEndpointAuthMethod: 'client_secret_post' });
    (h.verifyClientSecret as Mock).mockResolvedValue({ clientId: 'client-1' });

    const res = await call({ ...refreshBody, client_secret: 'right' });

    expect(res.statusCode).toBe(200);
    expect(res.body?.refresh_token).toBe('fam1.secret1');
    expect(h.verifyClientSecret).toHaveBeenCalledWith('client-1', 'right');
  });

  it('rate-limits refresh per client_id (429 + Retry-After) before touching the family', async () => {
    (h.tryIncrement as Mock).mockResolvedValue({ success: false, expiresAt: new Date(Date.now() + 30_000) });

    const res = await call(refreshBody);

    expect(res.statusCode).toBe(429);
    expectRejected(res, 'temporarily_unavailable');
    expect(res.headers['Retry-After']).toBeGreaterThan(0);
    expect(h.tryIncrement).toHaveBeenCalledWith('rate-limit:oauth-refresh:client-1', 600, 60_000);
    expect(h.findByFamilyId).not.toHaveBeenCalled();
  });

  it('does not spend the per-client budget on a failed client authentication', async () => {
    (h.findByClientId as Mock).mockResolvedValue({ ...rp, tokenEndpointAuthMethod: 'client_secret_post' });
    (h.verifyClientSecret as Mock).mockResolvedValue(null);

    await call({ ...refreshBody, client_secret: 'wrong' });

    expect(h.tryIncrement).not.toHaveBeenCalled();
  });

  it('caps refresh per IP above the per-client limit, and keeps 20 on the code exchange', () => {
    const limit = h.rateLimitOptions!.limit;
    expect(limit({ body: { grant_type: 'refresh_token' } })).toBe(1200);
    expect(limit({ body: { grant_type: 'authorization_code' } })).toBe(20);
    expect(limit({ body: {} })).toBe(20);
  });

  // rateLimit keys `rate-limit:${subject ?? ip}:${pathname}`, so a distinct refresh subject is what keeps
  // refresh volume from 429ing authorization_code requests from the same IP.
  it('counts refresh in its own per-IP bucket, leaving the code exchange on the default key', () => {
    const subject = h.rateLimitOptions!.subject!;
    expect(subject({ body: { grant_type: 'refresh_token' } })).toBe('refresh:203.0.113.7');
    expect(subject({ body: { grant_type: 'authorization_code' } })).toBeUndefined();
    expect(subject({ body: {} })).toBeUndefined();
  });

  const logCases: Array<[string, () => void, Record<string, unknown>, string, number]> = [
    [
      'reuse of a superseded token',
      () => (h.findByFamilyId as Mock).mockResolvedValue(family({ tokenHash: 'h:other' })),
      refreshBody,
      'invalid_grant',
      400,
    ],
    [
      'per-client rate limit',
      () => (h.tryIncrement as Mock).mockResolvedValue({ success: false, expiresAt: new Date(Date.now() + 30_000) }),
      refreshBody,
      'temporarily_unavailable',
      429,
    ],
    ['scope wider than the family', () => {}, { ...refreshBody, scope: 'files:write' }, 'invalid_scope', 400],
  ];

  it.each(logCases)('%s logs one [OAUTH_ERROR] line', async (_name, setup, reqBody, error, status) => {
    setup();
    const res = await call(reqBody);

    expect(res.statusCode).toBe(status);
    expect(res.oauthLines).toEqual([`[OAUTH_ERROR] route=oauth/token client=client-1 error=${error} status=${status}`]);
    expect(res.oauthLines[0]).not.toContain('secret0');
  });
});

/**
 * Every error response emits exactly one secret-free [OAUTH_ERROR] line naming the route, client,
 * error code and status, so client failures are countable per client_id.
 */
describe('POST /api/oauth/token error logging', () => {
  const SECRETS = { code: 'the-code', client_secret: 'top-secret-value', code_verifier: VALID_VERIFIER };
  const body = { ...baseBody, ...SECRETS };
  const confidential = { tokenEndpointAuthMethod: 'client_secret_post' };
  const pub = { tokenEndpointAuthMethod: 'none' };

  beforeEach(() => {
    vi.clearAllMocks();
    (h.findById as Mock).mockResolvedValue({ id: 'u1', email: 'u@x.com', username: 'u', tokenVersion: 0 });
    (h.validateClient as Mock).mockResolvedValue(pub);
    (h.validateClientSecret as Mock).mockResolvedValue(confidential);
    (h.verifyPkce as Mock).mockReturnValue(true);
    (h.grantCovers as Mock).mockReturnValue(true);
    seedValidCode(authCode('challenge'));
  });

  const cases: Array<[string, () => void, Record<string, unknown>, string, number, string?]> = [
    ['schema failure', () => {}, { ...body, redirect_uri: 'not-a-url' }, 'invalid_request', 400],
    ['unknown client', () => (h.validateClient as Mock).mockResolvedValue(null), body, 'unauthorized_client', 401],
    [
      'confidential secret failure',
      () => {
        (h.validateClient as Mock).mockResolvedValue(confidential);
        (h.validateClientSecret as Mock).mockResolvedValue(null);
      },
      body,
      'invalid_client',
      401,
    ],
    ['code not found', () => (h.findValidCode as Mock).mockResolvedValue(null), body, 'invalid_grant', 400],
    ['client mismatch', () => {}, { ...body, client_id: 'client-2' }, 'invalid_grant', 400, 'client-2'],
    ['PKCE missing', () => (h.findValidCode as Mock).mockResolvedValue(authCode('')), body, 'invalid_grant', 400],
    ['verifier mismatch', () => (h.verifyPkce as Mock).mockReturnValue(false), body, 'invalid_grant', 400],
    ['lost consume race', () => (h.consumeValidCode as Mock).mockResolvedValue(null), body, 'invalid_grant', 400],
    ['user not found', () => (h.findById as Mock).mockResolvedValue(null), body, 'invalid_grant', 400],
    [
      'relying-party consent missing',
      () => {
        (h.validateClient as Mock).mockResolvedValue({ ...pub, clientType: 'relying-party' });
        (h.findGrant as Mock).mockResolvedValue(null);
      },
      body,
      'access_denied',
      400,
    ],
    ['unsupported grant_type', () => {}, { ...body, grant_type: 'password' }, 'unsupported_grant_type', 400],
  ];

  it.each(cases)('%s logs one [OAUTH_ERROR] line', async (_name, setup, reqBody, error, status, client) => {
    setup();
    const res = await call(reqBody);

    expect(res.statusCode).toBe(status);
    expect(res.body?.error).toBe(error);
    expect(res.oauthLines).toEqual([
      `[OAUTH_ERROR] route=oauth/token client=${client ?? 'client-1'} error=${error} status=${status}`,
    ]);
    for (const secret of [...Object.values(SECRETS), 'id.jwt', 'a.jwt', 'r.jwt', 'oauth.jwt']) {
      expect(res.oauthLines[0]).not.toContain(secret);
    }
  });

  it('records the minting client on a first-party session and logs nothing', async () => {
    const res = await call(body);

    expect(res.body?.access_token).toBe('a.jwt');
    expect(h.issueSessionForRequest).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ createdVia: 'oauth-token', clientId: 'client-1' })
    );
    expect(res.oauthLines).toEqual([]);
  });

  it('issues no session for a relying party', async () => {
    (h.validateClient as Mock).mockResolvedValue({ ...pub, clientType: 'relying-party' });
    (h.findGrant as Mock).mockResolvedValue({ scopes: ['openid'] });

    const res = await call(body);

    expect(res.body?.access_token).toBe('oauth.jwt');
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
    expect(res.oauthLines).toEqual([]);
  });
});

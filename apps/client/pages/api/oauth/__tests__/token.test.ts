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
}));
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
  body?: { error?: string; error_description?: string; access_token?: string };
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

const call = (body: Record<string, unknown>) => {
  const res = mockRes();
  return (handler as unknown as (req: unknown, res: Res) => Promise<unknown>)({ body }, res).then(() => res);
};

const baseBody = {
  grant_type: 'authorization_code',
  code: 'the-code',
  redirect_uri: 'https://app.example/cb',
  client_id: 'client-1',
};

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

    const res = await call({ ...baseBody, code_verifier: 'nope' });

    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('invalid_grant');
    expect(h.consumeValidCode).not.toHaveBeenCalled();
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
  });

  it('lets a public client with a matching verifier complete PKCE', async () => {
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'none' });
    seedValidCode(authCode('challenge'));
    (h.verifyPkce as Mock).mockReturnValue(true);

    const res = await call({ ...baseBody, code_verifier: 'good' });

    expect(res.body?.access_token).toBe('a.jwt');
    expect(h.issueSessionForRequest).toHaveBeenCalledOnce();
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

    const res = await call({ ...baseBody, code_verifier: 'good' });

    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('invalid_grant');
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
  });

  it('mints a first-party id_token as NOT scope-limited (full claims even for scope=openid)', async () => {
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'none' });
    seedValidCode(authCode('challenge'));
    (h.verifyPkce as Mock).mockReturnValue(true);

    await call({ ...baseBody, code_verifier: 'good' });

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
    return call({ ...baseBody, code_verifier: 'good' });
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
});

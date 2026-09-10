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
  consumeValidCode: vi.fn(),
  findById: vi.fn(),
  issueSessionForRequest: vi.fn(async () => ({ accessToken: 'a.jwt', refreshToken: 'r.jwt' })),
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
  oauthAuthorizationCodeRepository: { consumeValidCode: h.consumeValidCode },
  userRepository: { findById: h.findById },
}));
vi.mock('@server/auth/issueSession', () => ({ issueSessionForRequest: h.issueSessionForRequest }));
vi.mock('@server/auth/tokenGenerator', () => ({ ACCESS_TOKEN_TTL_SECONDS: 3600 }));

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
    (h.consumeValidCode as Mock).mockResolvedValue(authCode(''));

    const res = await call({ ...baseBody, client_secret: 'right' });

    expect(res.body?.access_token).toBe('a.jwt');
    expect(h.issueSessionForRequest).toHaveBeenCalledOnce();
  });

  it('rejects a public client redeeming a challenge-less code (downgrade -> 400 invalid_grant)', async () => {
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'none' });
    (h.consumeValidCode as Mock).mockResolvedValue(authCode(''));

    const res = await call({ ...baseBody });

    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('invalid_grant');
    expect(res.body?.error_description).toMatch(/pkce required/i);
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
  });

  it('rejects a public client whose verifier does not match the challenge (400 invalid_grant)', async () => {
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'none' });
    (h.consumeValidCode as Mock).mockResolvedValue(authCode('challenge'));
    (h.verifyPkce as Mock).mockReturnValue(false);

    const res = await call({ ...baseBody, code_verifier: 'nope' });

    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('invalid_grant');
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
  });

  it('lets a public client with a matching verifier complete PKCE', async () => {
    (h.validateClient as Mock).mockResolvedValue({ tokenEndpointAuthMethod: 'none' });
    (h.consumeValidCode as Mock).mockResolvedValue(authCode('challenge'));
    (h.verifyPkce as Mock).mockReturnValue(true);

    const res = await call({ ...baseBody, code_verifier: 'good' });

    expect(res.body?.access_token).toBe('a.jwt');
    expect(h.issueSessionForRequest).toHaveBeenCalledOnce();
  });
});

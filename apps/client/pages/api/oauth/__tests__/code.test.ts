import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';

/**
 * Provider-side hardening for POST /api/oauth/code: a public client
 * (tokenEndpointAuthMethod 'none') MUST present a PKCE code_challenge, so the
 * token endpoint never has to redeem a downgraded, challenge-less code. A
 * confidential client ('client_secret_post') is unaffected and still gets a
 * code without one. These pin both directions - inverting the guard is a silent
 * break for every confidential client.
 *
 * baseApi is stubbed to pass-through so the exported handler is the raw
 * (req, res) function; only the oauthServer seam is mocked.
 */

const h = vi.hoisted(() => ({
  validateClient: vi.fn(),
  generateAuthCode: vi.fn(),
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
vi.mock('@server/auth/oauthServer', () => ({
  validateClient: h.validateClient,
  generateAuthCode: h.generateAuthCode,
}));

import handler from '../code';

type Res = {
  statusCode: number;
  body?: { error?: string; error_description?: string; code?: string };
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
  const req = { body, user: { id: 'u1' } };
  return (handler as unknown as (req: unknown, res: Res) => Promise<unknown>)(req, res).then(() => res);
};

const baseBody = {
  client_id: 'client-1',
  redirect_uri: 'https://app.example/cb',
};

describe('POST /api/oauth/code PKCE hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (h.generateAuthCode as Mock).mockResolvedValue('the-code');
  });

  it('rejects a public client that omits code_challenge (400 invalid_request), without minting a code', async () => {
    (h.validateClient as Mock).mockResolvedValue({
      tokenEndpointAuthMethod: 'none',
      allowedScopes: ['openid', 'email', 'profile'],
    });

    const res = await call({ ...baseBody });

    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('invalid_request');
    expect(res.body?.error_description).toMatch(/pkce/i);
    expect(h.generateAuthCode).not.toHaveBeenCalled();
  });

  it('mints a code for a confidential client with no code_challenge', async () => {
    (h.validateClient as Mock).mockResolvedValue({
      tokenEndpointAuthMethod: 'client_secret_post',
      allowedScopes: ['openid', 'email', 'profile'],
    });

    const res = await call({ ...baseBody });

    expect(res.body?.code).toBe('the-code');
    expect(h.generateAuthCode).toHaveBeenCalledOnce();
  });
});

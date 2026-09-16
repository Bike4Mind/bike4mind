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
  findGrant: vi.fn(),
  upsertGrant: vi.fn(),
  decideConsent: vi.fn(),
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
vi.mock('@bike4mind/database', () => ({
  oauthGrantRepository: { findGrant: h.findGrant, upsertGrant: h.upsertGrant },
}));
vi.mock('@server/auth/oauthConsent', () => ({ decideConsent: h.decideConsent }));

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

  it('mints a code for a public client that presents a code_challenge', async () => {
    // Positive control for the guard: dropping the `&& !code_challenge` clause (rejecting every
    // public client) would fail here while the omit-challenge case above stays green.
    (h.validateClient as Mock).mockResolvedValue({
      tokenEndpointAuthMethod: 'none',
      allowedScopes: ['openid', 'email', 'profile'],
    });

    const res = await call({ ...baseBody, code_challenge: 'a-challenge', code_challenge_method: 'S256' });

    expect(res.body?.code).toBe('the-code');
    expect(h.generateAuthCode).toHaveBeenCalledOnce();
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

/**
 * The relying-party consent gate (code.ts:65-91). Without these it never executes under test, so a
 * regression that dropped the consent check - and let a relying party mint a code with no recorded
 * grant - would pass CI green.
 */
describe('POST /api/oauth/code relying-party consent gate', () => {
  const relyingParty = {
    tokenEndpointAuthMethod: 'client_secret_post',
    clientType: 'relying-party',
    name: 'VibesWire',
    allowedScopes: ['openid', 'email', 'profile'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (h.generateAuthCode as Mock).mockResolvedValue('the-code');
  });

  it('returns consent_required and mints no code when consent is needed', async () => {
    (h.validateClient as Mock).mockResolvedValue(relyingParty);
    (h.findGrant as Mock).mockResolvedValue(null);
    (h.decideConsent as Mock).mockReturnValue('consent_required');

    const res = await call({ ...baseBody, scope: 'openid email' });

    expect(res.body).toMatchObject({ consent_required: true, client_name: 'VibesWire', scopes: ['openid', 'email'] });
    expect(h.generateAuthCode).not.toHaveBeenCalled();
    expect(h.upsertGrant).not.toHaveBeenCalled();
  });

  it('on Allow, widens (unions) the stored grant and then mints the code', async () => {
    (h.validateClient as Mock).mockResolvedValue(relyingParty);
    (h.findGrant as Mock).mockResolvedValue({ scopes: ['openid'] });
    (h.decideConsent as Mock).mockReturnValue('ok');

    const res = await call({ ...baseBody, scope: 'openid email', consent: true });

    expect(h.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        clientId: 'client-1',
        scopes: expect.arrayContaining(['openid', 'email']),
        source: 'authorize',
      })
    );
    // Never shrinks: a re-consent for a subset keeps the previously approved scope.
    const merged = (h.upsertGrant as Mock).mock.calls[0][0].scopes as string[];
    expect(merged).toContain('openid');
    expect(res.body?.code).toBe('the-code');
    expect(h.generateAuthCode).toHaveBeenCalledOnce();
  });
});

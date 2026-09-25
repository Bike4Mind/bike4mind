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

// A grammar-valid S256 challenge: 43 base64url chars (RFC 7636 Appendix B example).
const VALID_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

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

    const res = await call({ ...baseBody, code_challenge: VALID_CHALLENGE, code_challenge_method: 'S256' });

    expect(res.body?.code).toBe('the-code');
    expect(h.generateAuthCode).toHaveBeenCalledOnce();
  });

  it('rejects a code_challenge sent without code_challenge_method=S256 (400 invalid_request)', async () => {
    // Discovery advertises only S256, so a challenge with no explicit method must be rejected rather
    // than silently assumed S256. A non-S256 method is already rejected by the zod literal at parse.
    (h.validateClient as Mock).mockResolvedValue({
      tokenEndpointAuthMethod: 'none',
      allowedScopes: ['openid', 'email', 'profile'],
    });

    const res = await call({ ...baseBody, code_challenge: VALID_CHALLENGE });

    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('invalid_request');
    expect(res.body?.error_description).toMatch(/S256/);
    expect(h.generateAuthCode).not.toHaveBeenCalled();
  });

  it('rejects a code_challenge that is not a 43-char base64url S256 digest (400 invalid_request)', async () => {
    // RFC 7636 grammar guard at the boundary: a short/malformed challenge is rejected before it can
    // be stored and later matched against a hashed verifier.
    (h.validateClient as Mock).mockResolvedValue({
      tokenEndpointAuthMethod: 'none',
      allowedScopes: ['openid', 'email', 'profile'],
    });

    for (const bad of ['short', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '+']) {
      const res = await call({ ...baseBody, code_challenge: bad, code_challenge_method: 'S256' });
      expect(res.statusCode).toBe(400);
      expect(res.body?.error).toBe('invalid_request');
    }
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

  it('rejects a scope the client is not registered for (400 invalid_scope), minting no code', async () => {
    (h.validateClient as Mock).mockResolvedValue({
      tokenEndpointAuthMethod: 'client_secret_post',
      allowedScopes: ['openid', 'email', 'profile'],
    });

    const res = await call({ ...baseBody, scope: 'openid admin:everything' });

    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('invalid_scope');
    expect(res.body?.error_description).toMatch(/admin:everything/);
    expect(h.generateAuthCode).not.toHaveBeenCalled();
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

  it('on Allow, records the grant with the requested scopes and mints the code', async () => {
    (h.validateClient as Mock).mockResolvedValue(relyingParty);
    (h.findGrant as Mock).mockResolvedValue({ scopes: ['openid'] });
    (h.decideConsent as Mock).mockReturnValue('mint');

    const res = await call({ ...baseBody, scope: 'openid email', consent: true });

    // The caller hands upsertGrant the requested scopes verbatim; unioning with the prior grant
    // (widen, never shrink) is the repo's atomic $addToSet job, not a caller-side read-merge-write
    // that could lose-update between two tabs. That behavior is pinned in OAuthGrantModel.test.ts.
    expect(h.upsertGrant).toHaveBeenCalledWith({
      userId: 'u1',
      clientId: 'client-1',
      scopes: ['openid', 'email'],
      source: 'authorize',
    });
    expect(res.body?.code).toBe('the-code');
    expect(h.generateAuthCode).toHaveBeenCalledOnce();
  });

  it('parses prompt as a space-delimited set: "login consent" still forces consent', async () => {
    // OIDC Core 3.1.2.1: prompt is a space-delimited set. A bare `prompt === "consent"` would skip
    // forced consent for `prompt=login consent`.
    (h.validateClient as Mock).mockResolvedValue(relyingParty);
    (h.findGrant as Mock).mockResolvedValue({ scopes: ['openid', 'email'] });
    (h.decideConsent as Mock).mockReturnValue('consent_required');

    await call({ ...baseBody, scope: 'openid email', prompt: 'login consent' });

    expect(h.decideConsent).toHaveBeenCalledWith(expect.objectContaining({ forceConsent: true }));
  });

  it('does not force consent when prompt lacks the consent token', async () => {
    (h.validateClient as Mock).mockResolvedValue(relyingParty);
    (h.findGrant as Mock).mockResolvedValue({ scopes: ['openid', 'email'] });
    (h.decideConsent as Mock).mockReturnValue('mint');

    await call({ ...baseBody, scope: 'openid email', prompt: 'login' });

    expect(h.decideConsent).toHaveBeenCalledWith(expect.objectContaining({ forceConsent: false }));
  });
});

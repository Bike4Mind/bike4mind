import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * POST /api/oauth/ai-token mints outside the gated REST surface, so it re-applies the account
 * gates itself. A deletion-pending account must not be handed a new API key.
 */

const h = vi.hoisted(() => ({
  verifyClientSecret: vi.fn(),
  findById: vi.fn(),
  findByUserId: vi.fn(),
  verifyFederatedIdToken: vi.fn(),
  checkFederatedGrant: vi.fn(),
  isApiKeyAccessAllowed: vi.fn(),
  tryIncrement: vi.fn(),
  logOAuthError: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {
      use: () => chain,
      post: (fn: (req: unknown, res: unknown) => unknown) => fn,
    };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@bike4mind/database', () => ({
  agentRepository: {},
  organizationRepository: {},
  realtimeConnectionRepository: {},
  cacheRepository: { tryIncrementWithinLimitFixedWindow: h.tryIncrement },
}));
vi.mock('@bike4mind/database/auth', () => ({
  oauthClientRepository: { verifyClientSecret: h.verifyClientSecret },
  userApiKeyRepository: { findByUserId: h.findByUserId },
  userRepository: { findById: h.findById },
  UserApiKeyAuditLog: {},
}));
vi.mock('@bike4mind/services', () => ({
  API_KEY_USER_CAP_ERROR_CODE: 'API_KEY_USER_CAP',
  userApiKeyService: { MAX_EXCHANGE_KEY_TTL_MS: 3_600_000 },
}));
vi.mock('@bike4mind/server-utils/utils/apiKeyAccessGate', () => ({
  API_KEY_ACCESS_DENIED_MESSAGE: 'API keys require an active paid subscription',
  SUBSCRIPTION_REQUIRED_ERROR: 'subscription_required',
  isApiKeyAccessAllowed: h.isApiKeyAccessAllowed,
}));
vi.mock('@server/auth/federatedGrantGate', () => ({ checkFederatedGrant: h.checkFederatedGrant }));
vi.mock('@server/auth/verifyFederatedIdToken', () => ({
  verifyFederatedIdToken: h.verifyFederatedIdToken,
  FederatedIdTokenError: class FederatedIdTokenError extends Error {
    jwksUnavailable: boolean;
    jwksInvalid: boolean;
    constructor(message: string, options?: { jwksUnavailable?: boolean; jwksInvalid?: boolean }) {
      super(message);
      this.jwksUnavailable = options?.jwksUnavailable ?? false;
      this.jwksInvalid = options?.jwksInvalid ?? false;
    }
  },
}));
vi.mock('@server/auth/oauthErrorLog', () => ({ logAndRecordSideAppMintRefusal: h.logOAuthError }));

import { FederatedIdTokenError } from '@server/auth/verifyFederatedIdToken';
import handler from '../ai-token';

const CLIENT = {
  federatedIdp: { subjectSource: 'sub' },
  allowedScopes: ['ai:generate'],
};

const run = async (body: Record<string, unknown> = {}) => {
  const { req, res } = createMocks({
    method: 'POST',
    body: { client_id: 'client-1', client_secret: 'secret', id_token: 'id.token', ...body },
  });
  (req as unknown as Record<string, unknown>).logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

describe('POST /api/oauth/ai-token account gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.verifyClientSecret.mockResolvedValue(CLIENT);
    h.tryIncrement.mockResolvedValue({ success: true });
    h.verifyFederatedIdToken.mockResolvedValue({ b4mUserId: 'user-1' });
    h.checkFederatedGrant.mockResolvedValue(null);
    h.isApiKeyAccessAllowed.mockResolvedValue(true);
  });

  it('refuses a deletion-pending account before any key is minted', async () => {
    h.findById.mockResolvedValue({
      id: 'user-1',
      aupAcceptedVersion: 'v1',
      deletion: {
        requestedAt: new Date('2026-11-01T00:00:00Z'),
        scheduledFor: new Date('2026-12-01T00:00:00Z'),
        source: 'self_serve',
      },
    });

    const res = await run();

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toEqual({
      error: 'access_denied',
      error_description: 'Account is scheduled for deletion',
    });
    expect(h.isApiKeyAccessAllowed).not.toHaveBeenCalled();
  });

  it('refuses a subject that resolves to a system account as an invalid grant', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', aupAcceptedVersion: 'v1', isSystem: true });

    const res = await run();

    expect(res._getStatusCode()).toBe(401);
    expect(res._getJSONData()).toEqual({
      error: 'invalid_grant',
      error_description: 'Token subject does not resolve to a B4M user',
    });
    expect(h.checkFederatedGrant).not.toHaveBeenCalled();
  });

  const lastRefusal = () => h.logOAuthError.mock.calls.at(-1)?.[1];

  it('records a malformed request as unverified, whatever id it claims', async () => {
    const res = await run({ client_secret: undefined });
    expect(res._getStatusCode()).toBe(400);
    expect(lastRefusal()).toMatchObject({ error: 'invalid_request', status: 400, verified: false });
  });

  it('records a failed client authentication as unverified', async () => {
    h.verifyClientSecret.mockResolvedValue(null);
    const res = await run();
    expect(res._getStatusCode()).toBe(401);
    expect(lastRefusal()).toMatchObject({ error: 'invalid_client', status: 401, verified: false });
  });

  it('records refusals after client authentication as verified, with the user once resolved', async () => {
    h.verifyClientSecret.mockResolvedValue({ ...CLIENT, federatedIdp: undefined });
    await run();
    expect(lastRefusal()).toMatchObject({ error: 'access_denied', status: 403, verified: true, userId: undefined });

    h.verifyClientSecret.mockResolvedValue(CLIENT);
    h.findById.mockResolvedValue({ id: 'user-1', aupAcceptedVersion: undefined });
    await run();
    expect(lastRefusal()).toMatchObject({ error: 'access_denied', verified: true, userId: 'user-1' });
  });

  it('records a refused scope as verified', async () => {
    await run({ scope: 'ai:generate admin:all' });
    expect(lastRefusal()).toMatchObject({ error: 'invalid_scope', status: 403, verified: true });
  });

  it('records the per-client rate limit as an app fault, keeping the wire error', async () => {
    h.tryIncrement.mockResolvedValue({ success: false, expiresAt: new Date(Date.now() + 5000) });
    const res = await run();
    expect(res._getStatusCode()).toBe(429);
    expect(res._getJSONData().error).toBe('temporarily_unavailable');
    expect(lastRefusal()).toMatchObject({
      error: 'temporarily_unavailable',
      recordAs: 'rate_limited',
      status: 429,
      verified: true,
    });
  });

  describe('unexpected failures', () => {
    const OWN = 'https://app.example.test';
    const jwksFailure = () => new FederatedIdTokenError('ID token failed', { jwksUnavailable: true });
    const withIssuer = (issuer: string) =>
      h.verifyClientSecret.mockResolvedValue({
        federatedIdp: { subjectSource: 'sub', issuer },
        allowedScopes: ['ai:generate'],
      });
    const serverErrors = () => h.logOAuthError.mock.calls.filter(c => c[1].error === 'server_error');

    beforeEach(() => vi.stubEnv('APP_URL', `${OWN}/`));
    afterEach(() => vi.unstubAllEnvs());

    it('records a JWKS fetch failure on our own issuer as server_error, with the same 401', async () => {
      withIssuer(OWN);
      h.verifyFederatedIdToken.mockRejectedValue(jwksFailure());
      const res = await run();
      expect(res._getStatusCode()).toBe(401);
      expect(res._getJSONData().error).toBe('invalid_grant');
      expect(lastRefusal()).toMatchObject({ error: 'invalid_grant', recordAs: 'server_error', verified: true });
    });

    it('records a JWKS fetch failure on a third-party issuer as idp_unavailable', async () => {
      withIssuer('https://idp.other.test');
      h.verifyFederatedIdToken.mockRejectedValue(jwksFailure());
      const res = await run();
      expect(res._getStatusCode()).toBe(401);
      expect(lastRefusal()).toMatchObject({ error: 'invalid_grant', recordAs: 'idp_unavailable', verified: true });
    });

    it('records a malformed JWKS on our own issuer as server_error, with the same 401', async () => {
      withIssuer(OWN);
      h.verifyFederatedIdToken.mockRejectedValue(new FederatedIdTokenError('ID token failed', { jwksInvalid: true }));
      const res = await run();
      expect(res._getStatusCode()).toBe(401);
      expect(res._getJSONData().error).toBe('invalid_grant');
      expect(lastRefusal()).toMatchObject({ error: 'invalid_grant', recordAs: 'server_error', verified: true });
    });

    it('leaves a malformed JWKS on a third-party issuer recorded as invalid_grant', async () => {
      withIssuer('https://idp.other.test');
      h.verifyFederatedIdToken.mockRejectedValue(new FederatedIdTokenError('ID token failed', { jwksInvalid: true }));
      await run();
      expect(lastRefusal()).toMatchObject({ error: 'invalid_grant', recordAs: undefined });
    });

    it('keeps a signature or claim failure an app-side invalid_grant', async () => {
      withIssuer(OWN);
      h.verifyFederatedIdToken.mockRejectedValue(new FederatedIdTokenError('bad signature'));
      await run();
      expect(lastRefusal()).toMatchObject({ error: 'invalid_grant', recordAs: undefined });
    });

    it('records findByUserId throwing as one verified server_error, then rethrows', async () => {
      h.findById.mockResolvedValue({ id: 'user-1', aupAcceptedVersion: 'v1' });
      h.findByUserId.mockRejectedValue(new Error('mongo down'));
      await expect(run()).rejects.toThrow('mongo down');
      expect(serverErrors()).toHaveLength(1);
      expect(lastRefusal()).toMatchObject({ error: 'server_error', status: 500, verified: true, userId: 'user-1' });
    });

    it('records an unexpected verifier throw once', async () => {
      h.verifyFederatedIdToken.mockRejectedValue(new Error('boom'));
      await expect(run()).rejects.toThrow('boom');
      expect(serverErrors()).toHaveLength(1);
    });

    it('records verifyClientSecret throwing as unverified, never under the claimed id', async () => {
      h.verifyClientSecret.mockRejectedValue(new Error('bcrypt exploded'));
      await expect(run()).rejects.toThrow('bcrypt exploded');
      expect(serverErrors()).toHaveLength(1);
      expect(lastRefusal()).toMatchObject({ error: 'server_error', status: 500, verified: false });
    });
  });
});

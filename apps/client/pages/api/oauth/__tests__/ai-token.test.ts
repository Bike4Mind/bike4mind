import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * POST /api/oauth/ai-token mints outside the gated REST surface, so it re-applies the account
 * gates itself. A deletion-pending account must not be handed a new API key.
 */

const h = vi.hoisted(() => ({
  verifyClientSecret: vi.fn(),
  findById: vi.fn(),
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
  userApiKeyRepository: {},
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
  FederatedIdTokenError: class FederatedIdTokenError extends Error {},
}));
vi.mock('@server/auth/oauthErrorLog', () => ({ logAndRecordSideAppMintRefusal: h.logOAuthError }));

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

  it('records the per-client rate limit as verified', async () => {
    h.tryIncrement.mockResolvedValue({ success: false, expiresAt: new Date(Date.now() + 5000) });
    const res = await run();
    expect(res._getStatusCode()).toBe(429);
    expect(lastRefusal()).toMatchObject({ error: 'temporarily_unavailable', status: 429, verified: true });
  });

  it('records an unexpected failure as a verified server_error before rethrowing', async () => {
    h.verifyFederatedIdToken.mockRejectedValue(new Error('jwks unreachable'));
    await expect(run()).rejects.toThrow('jwks unreachable');
    expect(lastRefusal()).toMatchObject({ error: 'server_error', status: 500, verified: true });
  });
});

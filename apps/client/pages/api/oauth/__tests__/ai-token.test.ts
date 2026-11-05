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
vi.mock('@server/utils/apiKeyAccessGate', () => ({
  API_KEY_ACCESS_DENIED_MESSAGE: 'API keys require an active paid subscription',
  SUBSCRIPTION_REQUIRED_ERROR: 'subscription_required',
  isApiKeyAccessAllowed: h.isApiKeyAccessAllowed,
}));
vi.mock('@server/auth/federatedGrantGate', () => ({ checkFederatedGrant: h.checkFederatedGrant }));
vi.mock('@server/auth/verifyFederatedIdToken', () => ({
  verifyFederatedIdToken: h.verifyFederatedIdToken,
  FederatedIdTokenError: class FederatedIdTokenError extends Error {},
}));
vi.mock('@server/auth/oauthErrorLog', () => ({ logOAuthError: h.logOAuthError }));

import handler from '../ai-token';

const CLIENT = {
  federatedIdp: { subjectSource: 'sub' },
  allowedScopes: ['ai:generate'],
};

const run = async () => {
  const { req, res } = createMocks({
    method: 'POST',
    body: { client_id: 'client-1', client_secret: 'secret', id_token: 'id.token' },
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
});

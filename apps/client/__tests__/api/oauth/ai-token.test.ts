import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Unwrap the handler: baseApi().use(...).post(fn) => fn
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { use: () => chain, post: (fn: any) => fn };
    return chain;
  },
}));

// rateLimit middleware is a no-op factory here; the per-client limit is exercised
// via the cacheRepository mock below.
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => {} }));

// Minimal enum surface the handler reads (avoids loading real @bike4mind/common).
vi.mock('@bike4mind/common', () => ({
  ApiKeyScope: { AI_GENERATE: 'ai:generate' },
  ApiKeyStatus: { ACTIVE: 'active', RATE_LIMITED: 'rate_limited', DISABLED: 'disabled', EXPIRED: 'expired' },
}));

const mockTryIncrement = vi.fn();
vi.mock('@bike4mind/database', () => ({
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: (...args: any[]) => mockTryIncrement(...args),
  },
}));

const mockVerifyClientSecret = vi.fn();
const mockFindByUserId = vi.fn();
const mockUserFindById = vi.fn();
const mockAuditCreate = vi.fn();
vi.mock('@bike4mind/database/auth', () => ({
  oauthClientRepository: { verifyClientSecret: (...a: any[]) => mockVerifyClientSecret(...a) },
  userApiKeyRepository: { findByUserId: (...a: any[]) => mockFindByUserId(...a) },
  userRepository: { findById: (...a: any[]) => mockUserFindById(...a) },
  UserApiKeyAuditLog: { create: (...a: any[]) => mockAuditCreate(...a) },
}));

const mockCreateUserApiKey = vi.fn();
const mockRevokeUserApiKey = vi.fn();
vi.mock('@bike4mind/services', () => ({
  userApiKeyService: {
    createUserApiKey: (...a: any[]) => mockCreateUserApiKey(...a),
    revokeUserApiKey: (...a: any[]) => mockRevokeUserApiKey(...a),
  },
}));

const mockVerifyCognitoIdToken = vi.fn();
vi.mock('@server/auth/verifyCognitoIdToken', () => ({
  verifyCognitoIdToken: (...a: any[]) => mockVerifyCognitoIdToken(...a),
  // Defined inside the factory (hoisted): a class declaration in the module body
  // would be in its TDZ when the hoisted mock runs.
  CognitoIdTokenError: class CognitoIdTokenError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'CognitoIdTokenError';
    }
  },
}));

// Real consent gate (pure) - exercises the actual invariant, not a stub.

import handler from '../../../pages/api/oauth/ai-token';
import { CognitoIdTokenError } from '@server/auth/verifyCognitoIdToken';

const FEDERATED_CLIENT = {
  name: 'VibesWire',
  federatedIdp: {
    issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool',
    audience: 'app-client-id',
    providerName: 'B4M',
  },
};

const CONSENTED_USER = { id: 'b4m-user-1', aupAcceptedVersion: '2025-01-01' };

const VALID_BODY = { client_id: 'client-1', client_secret: 'secret', id_token: 'cognito-id-token' };

function makeReq(body: any = VALID_BODY, headers: Record<string, string> = {}) {
  const { req, res } = createMocks({ method: 'POST', body, headers });
  (req as any).logger = { info: vi.fn(), warn: vi.fn() };
  return { req, res };
}

describe('POST /api/oauth/ai-token — federated AI-token exchange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Defaults for the happy path; individual tests override.
    mockTryIncrement.mockResolvedValue({ success: true, expiresAt: new Date(Date.now() + 60_000) });
    mockVerifyClientSecret.mockResolvedValue(FEDERATED_CLIENT);
    mockVerifyCognitoIdToken.mockResolvedValue({ b4mUserId: 'b4m-user-1', claims: {} });
    mockUserFindById.mockResolvedValue(CONSENTED_USER);
    mockFindByUserId.mockResolvedValue([]);
    mockCreateUserApiKey.mockResolvedValue({ id: 'key-1', key: 'b4m_live_deadbeef', scopes: ['ai:generate'] });
    mockAuditCreate.mockResolvedValue({});
    mockRevokeUserApiKey.mockResolvedValue(undefined);
  });

  it('AC1/AC9: mints a scoped, short-lived key and returns it once', async () => {
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    const data = res._getJSONData();
    expect(data).toMatchObject({
      api_key: 'b4m_live_deadbeef',
      token_type: 'ApiKey',
      expires_in: 900,
      scope: 'ai:generate',
    });

    // minted with exactly ai:generate, oauth-exchange metadata, and an expiry ~15m out
    expect(mockCreateUserApiKey).toHaveBeenCalledTimes(1);
    const [userId, params] = mockCreateUserApiKey.mock.calls[0];
    expect(userId).toBe('b4m-user-1');
    expect(params.scopes).toEqual(['ai:generate']);
    expect(params.metadata).toMatchObject({ createdFrom: 'oauth-exchange', oauthClientId: 'client-1' });
    expect(params.expiresAt).toBeInstanceOf(Date);
    const ttlMs = params.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(890_000);
    expect(ttlMs).toBeLessThanOrEqual(900_000);
    // exchange keys must NOT be tagged via productId (avoids the per-product cap)
    expect(params.productId).toBeUndefined();
  });

  it('AC6: writes exactly one mint audit entry', async () => {
    const { req, res } = makeReq(
      { ...VALID_BODY },
      { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'VibesWire/1.0' }
    );
    await handler(req as any, res as any);

    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mint',
        keyId: 'key-1',
        actorUserId: 'b4m-user-1',
        actorIp: '203.0.113.9',
        actorUserAgent: 'VibesWire/1.0',
        details: { clientId: 'client-1', flow: 'oauth-ai-token-exchange' },
      })
    );
  });

  it('AC2: unknown client / bad client_secret → 401 invalid_client', async () => {
    mockVerifyClientSecret.mockResolvedValue(null);
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(401);
    expect(res._getJSONData().error).toBe('invalid_client');
    expect(mockCreateUserApiKey).not.toHaveBeenCalled();
  });

  it('AC2: registered but non-federated client → 403 access_denied', async () => {
    mockVerifyClientSecret.mockResolvedValue({ name: 'PlainSSO' }); // no federatedIdp
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toBe('access_denied');
    expect(mockVerifyCognitoIdToken).not.toHaveBeenCalled();
    expect(mockCreateUserApiKey).not.toHaveBeenCalled();
  });

  it('AC3: invalid Cognito token → 401 invalid_grant, no mint', async () => {
    mockVerifyCognitoIdToken.mockRejectedValue(new CognitoIdTokenError('bad signature'));
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(401);
    expect(res._getJSONData().error).toBe('invalid_grant');
    expect(mockCreateUserApiKey).not.toHaveBeenCalled();
  });

  it('AC3: token subject resolves to no B4M user → 401 invalid_grant', async () => {
    mockUserFindById.mockResolvedValue(null);
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(401);
    expect(res._getJSONData().error).toBe('invalid_grant');
    expect(mockCreateUserApiKey).not.toHaveBeenCalled();
  });

  it('AC4 (SECURITY): non-consented user → 403 access_denied, no key minted, no audit', async () => {
    mockUserFindById.mockResolvedValue({ id: 'b4m-user-1', aupAcceptedVersion: null });
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toBe('access_denied');
    expect(mockCreateUserApiKey).not.toHaveBeenCalled();
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('AC5: reuse-or-replace revokes the prior exchange key for this (user, client) before minting', async () => {
    mockFindByUserId.mockResolvedValue([
      { id: 'old-key', status: 'active', metadata: { createdFrom: 'oauth-exchange', oauthClientId: 'client-1' } },
      // other-client exchange key and a dashboard key must be left untouched
      { id: 'other-client', status: 'active', metadata: { createdFrom: 'oauth-exchange', oauthClientId: 'client-2' } },
      { id: 'dash-key', status: 'active', metadata: { createdFrom: 'dashboard' } },
    ]);
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect(mockRevokeUserApiKey).toHaveBeenCalledTimes(1);
    expect(mockRevokeUserApiKey).toHaveBeenCalledWith(
      'b4m-user-1',
      expect.objectContaining({ keyId: 'old-key' }),
      expect.anything()
    );
    // revoke happens before mint
    expect(mockRevokeUserApiKey.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateUserApiKey.mock.invocationCallOrder[0]
    );
  });

  it('AC8: per-client rate limit exceeded → 429', async () => {
    mockTryIncrement.mockResolvedValue({ success: false, expiresAt: new Date(Date.now() + 30_000) });
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(429);
    expect(mockVerifyCognitoIdToken).not.toHaveBeenCalled();
    expect(mockCreateUserApiKey).not.toHaveBeenCalled();
  });

  it('rejects a malformed body → 400 invalid_request', async () => {
    const { req, res } = makeReq({ client_id: 'only-id' });
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toBe('invalid_request');
  });
});

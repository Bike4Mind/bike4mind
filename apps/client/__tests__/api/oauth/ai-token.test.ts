import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
// BadRequestError is included (and constructed by the tests) so the handler's
// `instanceof` check sees the same class identity as the rejection it inspects.
vi.mock('@bike4mind/common', () => ({
  ApiKeyScope: { AI_GENERATE: 'ai:generate', ME_READ: 'me:read' },
  ApiKeyStatus: { ACTIVE: 'active', RATE_LIMITED: 'rate_limited', DISABLED: 'disabled', EXPIRED: 'expired' },
  BadRequestError: class BadRequestError extends Error {
    constructor(
      message?: string,
      public additionalInfo?: Record<string, unknown>
    ) {
      super(message);
      this.name = 'BadRequestError';
    }
  },
}));

const mockTryIncrement = vi.fn();
vi.mock('@bike4mind/database', () => ({
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: (...args: any[]) => mockTryIncrement(...args),
  },
  // Threaded into the revoke adapter; the exchange revokes the caller's own keys
  // (minter path), so findIdsAdministeredBy is never consulted here.
  organizationRepository: { findIdsAdministeredBy: vi.fn().mockResolvedValue([]) },
  // Required adapter on createUserApiKey; this flow never mints an embed key.
  agentRepository: { findById: vi.fn().mockResolvedValue(null) },
}));

const mockVerifyClientSecret = vi.fn();
const mockFindByUserId = vi.fn();
const mockUserFindById = vi.fn();
const mockAuditCreate = vi.fn();
const mockFindGrant = vi.fn();
vi.mock('@bike4mind/database/auth', () => ({
  oauthClientRepository: { verifyClientSecret: (...a: any[]) => mockVerifyClientSecret(...a) },
  oauthGrantRepository: { findGrant: (...a: any[]) => mockFindGrant(...a) },
  userApiKeyRepository: { findByUserId: (...a: any[]) => mockFindByUserId(...a) },
  userRepository: { findById: (...a: any[]) => mockUserFindById(...a) },
  UserApiKeyAuditLog: { create: (...a: any[]) => mockAuditCreate(...a) },
}));

const mockCreateUserApiKey = vi.fn();
const mockRevokeUserApiKey = vi.fn();
vi.mock('@bike4mind/services', () => ({
  API_KEY_USER_CAP_ERROR_CODE: 'API_KEY_USER_CAP',
  userApiKeyService: {
    createUserApiKey: (...a: any[]) => mockCreateUserApiKey(...a),
    revokeUserApiKey: (...a: any[]) => mockRevokeUserApiKey(...a),
  },
}));

const mockVerifyIdToken = vi.fn();
vi.mock('@server/auth/verifyFederatedIdToken', () => ({
  verifyFederatedIdToken: (...a: any[]) => mockVerifyIdToken(...a),
  // Defined inside the factory (hoisted): a class declaration in the module body
  // would be in its TDZ when the hoisted mock runs.
  FederatedIdTokenError: class FederatedIdTokenError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'FederatedIdTokenError';
    }
  },
}));

// Real consent gate (pure) - exercises the actual invariant, not a stub.

import handler from '../../../pages/api/oauth/ai-token';
import { FederatedIdTokenError } from '@server/auth/verifyFederatedIdToken';
import { BadRequestError } from '@bike4mind/common';
import { API_KEY_USER_CAP_ERROR_CODE } from '@bike4mind/services';

const FEDERATED_CLIENT = {
  name: 'VibesWire',
  // relying-party: the grant gate (step 5.5) only fires for these; a first-party client is exempt.
  clientType: 'relying-party',
  federatedIdp: {
    issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool',
    audience: 'app-client-id',
    providerName: 'B4M',
  },
  allowedScopes: ['openid', 'email', 'profile', 'ai:generate', 'me:read'],
};

// A client that signs users in directly against B4M: subjectSource 'sub', no providerName, explicit jwksUri.
const B4M_ISSUED_CLIENT = {
  name: 'Tarot',
  federatedIdp: {
    issuer: 'https://app.example.com',
    audience: 'b4m-oauth-client-id',
    jwksUri: 'https://app.example.com/api/oauth/jwks',
    subjectSource: 'sub',
  },
  allowedScopes: ['openid', 'email', 'profile', 'ai:generate', 'me:read'],
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
    mockVerifyIdToken.mockResolvedValue({ b4mUserId: 'b4m-user-1', claims: {} });
    mockUserFindById.mockResolvedValue(CONSENTED_USER);
    mockFindByUserId.mockResolvedValue([]);
    mockCreateUserApiKey.mockResolvedValue({ id: 'key-1', key: 'b4m_live_deadbeef', scopes: ['ai:generate'] });
    mockAuditCreate.mockResolvedValue({});
    mockRevokeUserApiKey.mockResolvedValue(undefined);
    // Default: user has an active grant covering the billable scope (realistic happy path). The
    // billable ai:generate scope - not mere grant existence - is what authorizes the mint.
    mockFindGrant.mockResolvedValue({
      userId: 'b4m-user-1',
      clientId: 'client-1',
      scopes: ['openid', 'ai:generate'],
    });
  });

  afterEach(() => {
    delete process.env.OAUTH_AI_TOKEN_ENFORCE_GRANT;
  });

  it('grant gate (enforce): valid token but no grant for this client -> 403 access_denied, no mint', async () => {
    process.env.OAUTH_AI_TOKEN_ENFORCE_GRANT = 'true';
    mockFindGrant.mockResolvedValue(null);
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toBe('access_denied');
    expect(mockFindGrant).toHaveBeenCalledWith('b4m-user-1', 'client-1');
    expect(mockCreateUserApiKey).not.toHaveBeenCalled();
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('grant gate (enforce): grant covering the billable scope -> mints normally', async () => {
    process.env.OAUTH_AI_TOKEN_ENFORCE_GRANT = 'true';
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect(mockCreateUserApiKey).toHaveBeenCalledTimes(1);
  });

  it('billable-scope gate (enforce): identity-only grant (no ai:generate) -> 403, no mint', async () => {
    // A client-identity grant is not spend authorization: an openid-only grant must not authorize a
    // billable ai:generate key the user never approved.
    process.env.OAUTH_AI_TOKEN_ENFORCE_GRANT = 'true';
    mockFindGrant.mockResolvedValue({ userId: 'b4m-user-1', clientId: 'client-1', scopes: ['openid'] });
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toBe('access_denied');
    expect(mockCreateUserApiKey).not.toHaveBeenCalled();
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('billable-scope gate (grace): identity-only grant still mints but logs a would-reject warning', async () => {
    mockFindGrant.mockResolvedValue({ userId: 'b4m-user-1', clientId: 'client-1', scopes: ['openid'] });
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect(mockCreateUserApiKey).toHaveBeenCalledTimes(1);
    expect((req as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining('lacks scope(s): ai:generate'));
  });

  it('grant gate (grace, default): no grant still mints but logs a would-reject warning', async () => {
    mockFindGrant.mockResolvedValue(null);
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect(mockCreateUserApiKey).toHaveBeenCalledTimes(1);
    expect((req as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining('would-reject'));
  });

  it('identities subjectSource (grace mode): mints successfully and logs would-reject with client_id', async () => {
    // FEDERATED_CLIENT has no subjectSource set (undefined !== 'sub'), so the call-site
    // grace log fires. Verify it names client_id, not the issuer URL.
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect((req as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining('would-reject'));
    expect((req as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining('client-1'));
    expect((req as any).logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('cognito-idp'));
  });

  it('grant gate (enforce): a first-party client with no grant still mints - the gate never runs for it', async () => {
    // Regression: enforcing a grant on first-party/pre-existing federated clients (which never go
    // through code.ts consent and so have no grant row) would 403 every such integration the moment
    // the lever flips. They must be exempt - findGrant is not even consulted.
    process.env.OAUTH_AI_TOKEN_ENFORCE_GRANT = 'true';
    mockVerifyClientSecret.mockResolvedValue({ ...FEDERATED_CLIENT, clientType: 'first-party' });
    mockFindGrant.mockResolvedValue(null);
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect(mockCreateUserApiKey).toHaveBeenCalledTimes(1);
    expect(mockFindGrant).not.toHaveBeenCalled();
  });

  it('grant gate (enforce): a grant-lookup error fails closed (503, no mint) - an unreadable grant is not "no grant"', async () => {
    // In enforcement mode an unreadable grant is UNKNOWN, not absent; minting anyway would defeat the
    // gate on exactly the transient error an attacker could induce.
    process.env.OAUTH_AI_TOKEN_ENFORCE_GRANT = 'true';
    mockFindGrant.mockRejectedValue(new Error('mongo unavailable'));
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(503);
    expect(res._getJSONData().error).toBe('temporarily_unavailable');
    expect(mockCreateUserApiKey).not.toHaveBeenCalled();
    expect(mockAuditCreate).not.toHaveBeenCalled();
    expect((req as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining('grant lookup failed'));
  });

  it('grant gate (grace, default): a grant-lookup error degrades to grace (mints, no 500)', async () => {
    mockFindGrant.mockRejectedValue(new Error('mongo unavailable'));
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect(mockCreateUserApiKey).toHaveBeenCalledTimes(1);
    expect((req as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining('grant lookup failed'));
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
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(mockCreateUserApiKey).not.toHaveBeenCalled();
  });

  it('AC3: invalid ID token → 401 invalid_grant, no mint', async () => {
    mockVerifyIdToken.mockRejectedValue(new FederatedIdTokenError('bad signature'));
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

  it('per-user key cap → 400 invalid_request, OAuth-shaped, no audit', async () => {
    // The service tags the cap refusal so the exchange answers in OAuth shape instead
    // of letting baseApi render a bare 400 the client cannot parse.
    mockCreateUserApiKey.mockRejectedValue(
      new BadRequestError('Maximum 10 active API keys allowed per user', { code: API_KEY_USER_CAP_ERROR_CODE })
    );
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({
      error: 'invalid_request',
      error_description: 'Maximum 10 active API keys allowed per user',
    });
    expect(mockAuditCreate).not.toHaveBeenCalled();
    expect((req as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining('cap reached'));
  });

  it('a non-cap error from mint still propagates unchanged (not relabeled)', async () => {
    // Only the tagged cap refusal may be rewritten; an untagged BadRequestError or a
    // generic failure stays the generic handler's to render (500/its own shape).
    mockCreateUserApiKey.mockRejectedValue(new BadRequestError('something else went wrong'));
    const first = makeReq();
    await expect(handler(first.req as any, first.res as any)).rejects.toThrow('something else went wrong');

    mockCreateUserApiKey.mockRejectedValue(new Error('mongo down'));
    const second = makeReq();
    await expect(handler(second.req as any, second.res as any)).rejects.toThrow('mongo down');
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('AC8: per-client rate limit exceeded → 429', async () => {
    mockTryIncrement.mockResolvedValue({ success: false, expiresAt: new Date(Date.now() + 30_000) });
    const { req, res } = makeReq();
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(429);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(mockCreateUserApiKey).not.toHaveBeenCalled();
  });

  it('rejects a malformed body → 400 invalid_request', async () => {
    const { req, res } = makeReq({ client_id: 'only-id' });
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toBe('invalid_request');
  });

  describe('allowedScopes enforcement (step 2.5)', () => {
    it('scope not in allowedScopes → 403 invalid_scope, no mint', async () => {
      mockVerifyClientSecret.mockResolvedValue({ ...FEDERATED_CLIENT, allowedScopes: ['ai:generate'] });
      const { req, res } = makeReq({ ...VALID_BODY, scope: 'ai:generate me:read' });
      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().error).toBe('invalid_scope');
      expect(res._getJSONData().error_description).toContain('me:read');
      expect(mockCreateUserApiKey).not.toHaveBeenCalled();
    });

    it('all requested scopes in allowedScopes → proceeds to mint', async () => {
      const { req, res } = makeReq({ ...VALID_BODY, scope: 'ai:generate me:read' });
      // Grant covers both scopes for the billable scope check.
      mockFindGrant.mockResolvedValue({
        userId: 'b4m-user-1',
        clientId: 'client-1',
        scopes: ['ai:generate', 'me:read'],
      });
      mockCreateUserApiKey.mockResolvedValue({
        id: 'key-2',
        key: 'b4m_live_cafebabe',
        scopes: ['ai:generate', 'me:read'],
      });
      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
      const data = res._getJSONData();
      expect(data.scope).toBe('ai:generate me:read');
      const [, params] = mockCreateUserApiKey.mock.calls[0];
      expect(params.scopes).toEqual(['ai:generate', 'me:read']);
    });
  });

  describe('scope validation before key rotation', () => {
    beforeEach(() => {
      process.env.OAUTH_AI_TOKEN_ENFORCE_GRANT = 'true';
      mockFindByUserId.mockResolvedValue([
        { id: 'old-key', status: 'active', metadata: { createdFrom: 'oauth-exchange', oauthClientId: 'client-1' } },
      ]);
    });

    it.each(['', ' ', '   ', '\t', '\n', null, 42])('rejects malformed scope %j without revoking', async scope => {
      const { req, res } = makeReq({ ...VALID_BODY, scope });
      await handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]);

      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData().error).toBe('invalid_request');
      expect(mockFindByUserId).not.toHaveBeenCalled();
      expect(mockRevokeUserApiKey).not.toHaveBeenCalled();
      expect(mockCreateUserApiKey).not.toHaveBeenCalled();
    });

    it.each([
      'openid',
      'email',
      'profile',
      'ai:generate openid',
      'ai:chat',
      'optihashi:compute',
      'datalake:query',
      'admin:*',
      'embed:chat',
      'overwatch-ingest:write',
      'cc-bridge:connect',
      'AI:GENERATE',
      'ai:generate\tme:read',
      'unknown:scope',
    ])('rejects registered but unsupported scope %j without revoking', async scope => {
      mockVerifyClientSecret.mockResolvedValue({
        ...FEDERATED_CLIENT,
        allowedScopes: [...FEDERATED_CLIENT.allowedScopes, ...scope.split(' ')],
      });
      mockFindGrant.mockResolvedValue({ userId: 'b4m-user-1', clientId: 'client-1', scopes: ['openid'] });
      const { req, res } = makeReq({ ...VALID_BODY, scope });
      await handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]);

      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().error).toBe('invalid_scope');
      expect(mockVerifyIdToken).not.toHaveBeenCalled();
      expect(mockFindByUserId).not.toHaveBeenCalled();
      expect(mockRevokeUserApiKey).not.toHaveBeenCalled();
      expect(mockCreateUserApiKey).not.toHaveBeenCalled();
    });

    it('accepts surrounding and repeated spaces in a supported scope set', async () => {
      mockFindGrant.mockResolvedValue({
        userId: 'b4m-user-1',
        clientId: 'client-1',
        scopes: ['openid', 'ai:generate', 'me:read'],
      });
      mockCreateUserApiKey.mockResolvedValue({
        id: 'key-1',
        key: 'b4m_live_deadbeef',
        scopes: ['ai:generate', 'me:read'],
      });
      const { req, res } = makeReq({ ...VALID_BODY, scope: '  ai:generate  me:read  ' });
      await handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().scope).toBe('ai:generate me:read');
      expect(mockCreateUserApiKey).toHaveBeenCalledWith(
        'b4m-user-1',
        expect.objectContaining({ scopes: ['ai:generate', 'me:read'] }),
        expect.anything()
      );
    });

    it('requires AI consent for a mixed supported scope set', async () => {
      mockFindGrant.mockResolvedValue({ userId: 'b4m-user-1', clientId: 'client-1', scopes: ['openid'] });
      const { req, res } = makeReq({ ...VALID_BODY, scope: 'ai:generate me:read' });
      await handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]);

      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().error).toBe('access_denied');
      expect(mockRevokeUserApiKey).not.toHaveBeenCalled();
      expect(mockCreateUserApiKey).not.toHaveBeenCalled();
    });
  });

  describe('scope parameter - defaults and non-billable', () => {
    it('omitting scope defaults to ai:generate', async () => {
      const { req, res } = makeReq(VALID_BODY);
      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().scope).toBe('ai:generate');
      const [, params] = mockCreateUserApiKey.mock.calls[0];
      expect(params.scopes).toEqual(['ai:generate']);
    });

    it('me:read with a grant that covers it -> mints normally', async () => {
      process.env.OAUTH_AI_TOKEN_ENFORCE_GRANT = 'true';
      mockFindGrant.mockResolvedValue({ userId: 'b4m-user-1', clientId: 'client-1', scopes: ['openid', 'me:read'] });
      mockCreateUserApiKey.mockResolvedValue({ id: 'key-3', key: 'b4m_live_abc123', scopes: ['me:read'] });
      const { req, res } = makeReq({ ...VALID_BODY, scope: 'me:read' });
      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().scope).toBe('me:read');
      const [, params] = mockCreateUserApiKey.mock.calls[0];
      expect(params.scopes).toEqual(['me:read']);
    });

    it('me:read with an identity-only grant (no me:read) -> 403 in enforce mode', async () => {
      // The grant must cover every minted scope, not just billable ones.
      process.env.OAUTH_AI_TOKEN_ENFORCE_GRANT = 'true';
      mockFindGrant.mockResolvedValue({ userId: 'b4m-user-1', clientId: 'client-1', scopes: ['openid'] });
      const { req, res } = makeReq({ ...VALID_BODY, scope: 'me:read' });
      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().error).toBe('access_denied');
      expect(res._getJSONData().error_description).toContain('me:read');
      expect(mockCreateUserApiKey).not.toHaveBeenCalled();
    });

    it('non-billable scope + enforce=true + NO grant -> 403 access_denied (hole-a still applies)', async () => {
      // Even when only non-billable scopes are requested, the grant-existence check (hole-a) still
      // fires: a pool-signed token for a user who never authorized this client must be rejected,
      // regardless of whether the requested scopes are billable.
      process.env.OAUTH_AI_TOKEN_ENFORCE_GRANT = 'true';
      mockFindGrant.mockResolvedValue(null);
      const { req, res } = makeReq({ ...VALID_BODY, scope: 'me:read' });
      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().error).toBe('access_denied');
      expect(mockCreateUserApiKey).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });
  });

  // A client that signs its users in against B4M's own OIDC provider directly
  // (subjectSource: 'sub') - no Cognito hop. The route itself has no branch for
  // this: it hands the whole trust config to the verifier. These tests pin that
  // every gate keeps firing on the new path.
  describe('client whose trust config is subjectSource: sub (B4M-issued token)', () => {
    beforeEach(() => {
      mockVerifyClientSecret.mockResolvedValue(B4M_ISSUED_CLIENT);
      mockVerifyIdToken.mockResolvedValue({ b4mUserId: 'b4m-user-1', claims: { sub: 'b4m-user-1' } });
    });

    it('mints against the sub-resolved user, passing the trust config through verbatim', async () => {
      const { req, res } = makeReq();
      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toMatchObject({ api_key: 'b4m_live_deadbeef', scope: 'ai:generate' });
      expect(mockVerifyIdToken).toHaveBeenCalledWith('cognito-id-token', B4M_ISSUED_CLIENT.federatedIdp);
      expect(mockCreateUserApiKey.mock.calls[0][0]).toBe('b4m-user-1');
    });

    it('still enforces the consent gate', async () => {
      mockUserFindById.mockResolvedValue({ id: 'b4m-user-1', aupAcceptedVersion: null });
      const { req, res } = makeReq();
      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(403);
      expect(mockCreateUserApiKey).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('still enforces the per-client rate limit', async () => {
      mockTryIncrement.mockResolvedValue({ success: false, expiresAt: new Date(Date.now() + 30_000) });
      const { req, res } = makeReq();
      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(429);
      expect(mockVerifyIdToken).not.toHaveBeenCalled();
    });

    it('still writes a mint audit entry', async () => {
      const { req, res } = makeReq();
      await handler(req as any, res as any);

      expect(mockAuditCreate).toHaveBeenCalledTimes(1);
      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'mint', actorUserId: 'b4m-user-1' })
      );
    });

    it('still enforces reuse-or-replace before minting', async () => {
      mockFindByUserId.mockResolvedValue([
        { id: 'old-key', status: 'active', metadata: { createdFrom: 'oauth-exchange', oauthClientId: 'client-1' } },
      ]);
      const { req, res } = makeReq();
      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
      expect(mockRevokeUserApiKey).toHaveBeenCalledTimes(1);
    });

    it('a rejected ID token → 401 invalid_grant, no mint', async () => {
      mockVerifyIdToken.mockRejectedValue(new FederatedIdTokenError('Issuer not allowed'));
      const { req, res } = makeReq();
      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(401);
      expect(res._getJSONData().error).toBe('invalid_grant');
      expect(mockCreateUserApiKey).not.toHaveBeenCalled();
    });
  });
});

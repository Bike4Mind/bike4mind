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

const mockTryIncrement = vi.fn();
vi.mock('@bike4mind/database', () => ({
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: (...args: any[]) => mockTryIncrement(...args),
  },
}));

vi.mock('@bike4mind/services', () => ({
  userService: {
    accountBlockReasons: (u: any) => (u.isBanned ? ['banned'] : []),
  },
}));

const mockVerifyClientSecret = vi.fn();
const mockUserFindById = vi.fn();
vi.mock('@bike4mind/database/auth', () => ({
  oauthClientRepository: { verifyClientSecret: (...a: any[]) => mockVerifyClientSecret(...a) },
  userRepository: { findById: (...a: any[]) => mockUserFindById(...a) },
}));

const mockVerifyIdToken = vi.fn();
vi.mock('@server/auth/verifyFederatedIdToken', () => ({
  verifyFederatedIdToken: (...a: any[]) => mockVerifyIdToken(...a),
  FederatedIdTokenError: class FederatedIdTokenError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'FederatedIdTokenError';
    }
  },
}));

const mockCheckGrant = vi.fn();
vi.mock('@server/auth/federatedGrantGate', () => ({
  checkFederatedGrant: (...a: any[]) => mockCheckGrant(...a),
}));

import handler from '../../../pages/api/oauth/federated-admin';
import { FederatedIdTokenError } from '@server/auth/verifyFederatedIdToken';

const FEDERATED_CLIENT = {
  name: 'K2',
  federatedIdp: {
    issuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_pool',
    audience: 'app-client-id',
    providerName: 'B4M',
  },
};

const VALID_BODY = { client_id: 'client-1', client_secret: 'secret', id_token: 'cognito-id-token' };

function makeReq(body: any = VALID_BODY) {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as any).logger = { info: vi.fn(), warn: vi.fn() };
  return { req, res };
}

async function call(body?: any) {
  const { req, res } = makeReq(body);
  await (handler as any)(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() };
}

describe('POST /api/oauth/federated-admin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTryIncrement.mockResolvedValue({ success: true, expiresAt: new Date(Date.now() + 60_000) });
    mockVerifyClientSecret.mockResolvedValue(FEDERATED_CLIENT);
    mockVerifyIdToken.mockResolvedValue({ b4mUserId: 'b4m-user-1', claims: {} });
    mockUserFindById.mockResolvedValue({ id: 'b4m-user-1', isAdmin: true });
    mockCheckGrant.mockResolvedValue(null);
  });

  it('returns is_admin true for an admin user', async () => {
    expect(await call()).toEqual({ status: 200, body: { is_admin: true } });
    expect(mockVerifyIdToken).toHaveBeenCalledWith('cognito-id-token', FEDERATED_CLIENT.federatedIdp);
    expect(mockUserFindById).toHaveBeenCalledWith('b4m-user-1');
  });

  it('returns is_admin false for a non-admin user', async () => {
    mockUserFindById.mockResolvedValue({ id: 'b4m-user-1', isAdmin: false });
    expect(await call()).toEqual({ status: 200, body: { is_admin: false } });
  });

  it('returns is_admin false when the subject resolves to no user', async () => {
    mockUserFindById.mockResolvedValue(null);
    expect(await call()).toEqual({ status: 200, body: { is_admin: false } });
  });

  it('returns is_admin false for a blocked admin account', async () => {
    mockUserFindById.mockResolvedValue({ id: 'b4m-user-1', isAdmin: true, isBanned: true });
    expect(await call()).toEqual({ status: 200, body: { is_admin: false } });
  });

  it('enforces the grant gate before loading the user', async () => {
    mockCheckGrant.mockResolvedValue({
      status: 403,
      error: 'access_denied',
      error_description: 'User has not authorized this client',
    });
    const { status, body } = await call();
    expect(status).toBe(403);
    expect(body.error).toBe('access_denied');
    expect(mockCheckGrant).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'client-1', userId: 'b4m-user-1', scopes: [], enforce: true })
    );
    expect(mockUserFindById).not.toHaveBeenCalled();
  });

  it('rejects a malformed body with 400', async () => {
    const { status } = await call({ client_id: 'client-1' });
    expect(status).toBe(400);
    expect(mockVerifyClientSecret).not.toHaveBeenCalled();
  });

  it('rejects bad client credentials with 401 before verifying the token', async () => {
    mockVerifyClientSecret.mockResolvedValue(null);
    const { status, body } = await call();
    expect(status).toBe(401);
    expect(body.error).toBe('invalid_client');
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it('rejects a client without a federated trust config with 403', async () => {
    mockVerifyClientSecret.mockResolvedValue({ name: 'Plain' });
    expect((await call()).status).toBe(403);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it('rejects an invalid ID token with 401', async () => {
    mockVerifyIdToken.mockRejectedValue(new FederatedIdTokenError('bad signature'));
    const { status, body } = await call();
    expect(status).toBe(401);
    expect(body.error).toBe('invalid_grant');
    expect(mockUserFindById).not.toHaveBeenCalled();
  });

  it('rate-limits per client_id with 429', async () => {
    mockTryIncrement.mockResolvedValue({ success: false, expiresAt: new Date(Date.now() + 30_000) });
    expect((await call()).status).toBe(429);
    expect(mockTryIncrement.mock.calls[0][0]).toBe('rate-limit:oauth-federated-admin:client-1');
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });
});

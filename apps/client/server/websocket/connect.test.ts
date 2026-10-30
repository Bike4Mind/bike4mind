import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Covers the connect-time token gates: `typ`, the `kind:'oauth'` rejection, and the
 * tokenVersion kill switch.
 * These must agree with the REST strategy (auth/verifyJwtPayload.ts) and the
 * subscribe/unsubscribe path (verifyWsAccessToken.ts). The JWT is delivered on the
 * Sec-WebSocket-Protocol header (the CLI transport) since the `?token=` query path
 * was removed; both transports resolve identity through the same resolveIdentity.
 */

const mockFindById = vi.fn();
const mockConnectionCreate = vi.fn();
vi.mock('@bike4mind/database', () => ({
  User: { findById: (...args: unknown[]) => mockFindById(...args) },
  Connection: { create: (...args: unknown[]) => mockConnectionCreate(...args) },
}));

const mockVerifyToken = vi.fn();
vi.mock('@server/auth/tokenGenerator', () => ({
  authTokenGenerator: { verifyToken: (...args: unknown[]) => mockVerifyToken(...args) },
}));

vi.mock('@bike4mind/services', () => ({
  isTokenTypeAcceptable: (tokenType: unknown, expected: string) => tokenType === undefined || tokenType === expected,
  isTokenVersionCurrent: (payloadVersion?: number, userVersion?: number) =>
    (payloadVersion ?? 0) === (userVersion ?? 0),
}));

const mockVerifyApiKey = vi.fn();
vi.mock('@server/cli/auth', () => ({
  verifyApiKey: (...args: unknown[]) => mockVerifyApiKey(...args),
}));

const mockAssertAccountStateUsable = vi.fn();
vi.mock('@bike4mind/server-utils/auth/assertAccountStateUsable', () => ({
  assertAccountStateUsable: (...args: unknown[]) => mockAssertAccountStateUsable(...args),
}));

const mockAssertSessionActive = vi.fn();
const GATEWAY_CAP_EXPIRY = new Date('2030-01-01T02:00:00Z');
vi.mock('@server/websocket/realtimeSession', () => ({
  gatewayCapExpiry: () => GATEWAY_CAP_EXPIRY,
  assertRealtimeSessionActive: (...args: unknown[]) => mockAssertSessionActive(...args),
}));

const mockIpBlockRefusal = vi.fn();
vi.mock('@server/middlewares/checkBlockedIP', () => ({
  ipBlockRefusal: (...args: unknown[]) => mockIpBlockRefusal(...args),
}));

vi.mock('@server/websocket/utils', () => ({
  withWebSocketContext: vi.fn(
    (handler: (event: unknown, context: unknown, logger: unknown) => Promise<unknown>) => handler
  ),
}));

import { func } from './connect';
import { toApiKeyAuthError } from '@server/auth/apiKeyAuthFailure';
import { UnauthorizedError } from '@bike4mind/server-utils/utils/errors';

const eventWithToken = (token = 'token-123') => ({
  requestContext: { connectionId: 'conn-1' },
  queryStringParameters: {},
  headers: { 'sec-websocket-protocol': `access_token.${token}` },
});
const noopLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

const connect = (token?: string) => func(eventWithToken(token) as any, {} as any, noopLogger as any);

describe('websocket connect - token gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyToken.mockReturnValue({ id: 'user-1', tokenVersion: 3, typ: 'access' });
    mockFindById.mockResolvedValue({ id: 'user-1', tokenVersion: 3, save: vi.fn() });
    mockVerifyApiKey.mockRejectedValue(new Error('not an api key'));
    mockConnectionCreate.mockResolvedValue({});
    mockAssertAccountStateUsable.mockReturnValue(undefined);
    mockAssertSessionActive.mockResolvedValue(undefined);
    mockIpBlockRefusal.mockResolvedValue(null);
  });

  it("records a CLI JWT's sid and tokenVersion, bounded by the gateway cap rather than the token exp", async () => {
    const exp = Math.floor(new Date('2030-01-01T00:30:00Z').getTime() / 1000);
    mockVerifyToken.mockReturnValue({ id: 'user-1', tokenVersion: 3, typ: 'access', sid: 'sid-9', exp });

    await connect();

    expect(mockAssertSessionActive).toHaveBeenCalledWith('sid-9');
    expect(mockConnectionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ sid: 'sid-9', tokenVersion: 3, authExpiresAt: GATEWAY_CAP_EXPIRY })
    );
  });

  it('refuses a CLI JWT whose session has been revoked', async () => {
    mockVerifyToken.mockReturnValue({ id: 'user-1', tokenVersion: 3, typ: 'access', sid: 'sid-9' });
    mockAssertSessionActive.mockRejectedValueOnce(new Error('Session expired'));

    await expect(connect()).rejects.toThrow('Session expired');
    expect(mockConnectionCreate).not.toHaveBeenCalled();
  });

  it('records the API key id and the gateway-cap expiry for an API-key connection', async () => {
    mockVerifyToken.mockImplementation(() => {
      throw new Error('jwt malformed');
    });
    mockVerifyApiKey.mockResolvedValue({ keyId: 'key-1', userId: 'user-1', scopes: ['ai:chat'] });

    await connect();

    const created = mockConnectionCreate.mock.calls[0][0];
    expect(created).toEqual(expect.objectContaining({ apiKeyId: 'key-1', authExpiresAt: GATEWAY_CAP_EXPIRY }));
    expect(created).not.toHaveProperty('sid');
    expect(created).not.toHaveProperty('tokenVersion');
  });

  it('registers the connection for a current access token', async () => {
    await expect(connect()).resolves.toEqual({ statusCode: 200 });
    expect(mockConnectionCreate).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', source: 'cli' }));
  });

  it('refuses a refresh token presented as a connect token', async () => {
    mockVerifyToken.mockReturnValue({ id: 'user-1', tokenVersion: 3, typ: 'refresh' });

    await expect(connect()).rejects.toThrow('Invalid authentication token');
    expect(mockConnectionCreate).not.toHaveBeenCalled();
  });

  it('refuses a relying-party OAuth access token on the realtime socket', async () => {
    mockVerifyToken.mockReturnValue({ id: 'user-1', tokenVersion: 3, typ: 'access', kind: 'oauth' });

    await expect(connect()).rejects.toThrow('Invalid authentication token');
    expect(mockConnectionCreate).not.toHaveBeenCalled();
  });

  it('refuses an mfaPending token on the realtime socket', async () => {
    mockVerifyToken.mockReturnValue({ id: 'user-1', tokenVersion: 3, typ: 'access', mfaPending: true });

    await expect(connect()).rejects.toThrow('Invalid authentication token');
    expect(mockConnectionCreate).not.toHaveBeenCalled();
  });

  it('refuses a token whose tokenVersion is stale relative to the user', async () => {
    mockVerifyToken.mockReturnValue({ id: 'user-1', tokenVersion: 2, typ: 'access' });

    await expect(connect()).rejects.toThrow('Session expired');
    expect(mockConnectionCreate).not.toHaveBeenCalled();
  });

  it('accepts a legacy token carrying no typ against a default-version user', async () => {
    mockVerifyToken.mockReturnValue({ id: 'user-1' });
    mockFindById.mockResolvedValue({ id: 'user-1', save: vi.fn() });

    await expect(connect()).resolves.toEqual({ statusCode: 200 });
  });

  it('still allows the API-key fallback when the token is not a JWT', async () => {
    mockVerifyToken.mockImplementation(() => {
      throw new Error('jwt malformed');
    });
    mockVerifyApiKey.mockResolvedValue({ userId: 'user-1', scopes: ['ai:chat'] });

    await expect(connect()).resolves.toEqual({ statusCode: 200 });
    expect(mockConnectionCreate).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['ai:chat'] }));
  });

  it('refuses a blocked account before registering the connection', async () => {
    mockAssertAccountStateUsable.mockImplementation(() => {
      throw new Error('blocked');
    });

    await expect(connect()).rejects.toThrow('blocked');
    expect(mockConnectionCreate).not.toHaveBeenCalled();
  });

  it("refuses a connection from an address under an admin's all-scope IP block", async () => {
    mockIpBlockRefusal.mockResolvedValue({ message: 'network blocked', scope: 'all', expiresAt: new Date() });
    const event = {
      ...eventWithToken(),
      requestContext: { connectionId: 'conn-1', identity: { sourceIp: '203.0.113.9' } },
    };

    await expect(func(event as any, {} as any, noopLogger as any)).rejects.toThrow('network blocked');
    expect(mockIpBlockRefusal).toHaveBeenCalledWith(
      { headers: event.headers, socket: { remoteAddress: '203.0.113.9' } },
      'app',
      noopLogger
    );
    expect(mockConnectionCreate).not.toHaveBeenCalled();
  });

  it('lets an admin connect from a blocked address', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', tokenVersion: 3, isAdmin: true, save: vi.fn() });
    mockIpBlockRefusal.mockResolvedValue({ message: 'network blocked', scope: 'all', expiresAt: new Date() });

    await connect();
    expect(mockIpBlockRefusal).not.toHaveBeenCalled();
    expect(mockConnectionCreate).toHaveBeenCalled();
  });
});

const databaseUnreachable = () =>
  toApiKeyAuthError(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:27017'), { name: 'MongoNetworkError' }));

describe('websocket connect - API-key check outcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyToken.mockImplementation(() => {
      throw new Error('jwt malformed');
    });
    mockConnectionCreate.mockResolvedValue({});
  });

  it('propagates the 503 and creates no Connection when the database is unreachable', async () => {
    mockVerifyApiKey.mockRejectedValue(databaseUnreachable());

    const error = await connect().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ statusCode: 503, message: 'Authentication temporarily unavailable' });
    expect(String((error as Error).message)).not.toContain('ECONNREFUSED');
    expect(mockConnectionCreate).not.toHaveBeenCalled();
  });

  it('rejects with a 401 for an unknown key that is not a JWT either', async () => {
    mockVerifyApiKey.mockRejectedValue(new UnauthorizedError('Invalid or expired API key'));

    const error = await connect().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ statusCode: 401 });
    expect(mockConnectionCreate).not.toHaveBeenCalled();
  });
});

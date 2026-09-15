import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Covers the connect-time token gates only: `typ` and the tokenVersion kill switch.
 * These must agree with the REST strategy (auth/verifyJwtPayload.ts) and the
 * subscribe/unsubscribe path (verifyWsAccessToken.ts).
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

const mockVerifyApiKey = vi.fn();
vi.mock('@server/cli/auth', () => ({
  verifyApiKey: (...args: unknown[]) => mockVerifyApiKey(...args),
}));

vi.mock('@server/websocket/utils', () => ({
  withWebSocketContext: vi.fn(
    (handler: (event: unknown, context: unknown, logger: unknown) => Promise<unknown>) => handler
  ),
}));

import { func } from './connect';

const eventWithToken = (token = 'token-123') => ({
  requestContext: { connectionId: 'conn-1' },
  queryStringParameters: { token },
  headers: {},
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
  });

  it('registers the connection for a current access token', async () => {
    await expect(connect()).resolves.toEqual({ statusCode: 200 });
    expect(mockConnectionCreate).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', source: 'web' }));
  });

  it('refuses a refresh token presented as a connect token', async () => {
    mockVerifyToken.mockReturnValue({ id: 'user-1', tokenVersion: 3, typ: 'refresh' });

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
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@bike4mind/database', () => ({
  Connection: { findOne: vi.fn() },
}));

vi.mock('@server/cli/auth', () => ({
  verifyBridgeApiKey: vi.fn().mockRejectedValue(new Error('no api key')),
  verifyJwtToken: vi.fn().mockResolvedValue({ id: 'u1' }),
  checkRateLimit: vi.fn().mockResolvedValue(undefined),
  checkApiKeyRateLimitOrThrow: vi.fn().mockResolvedValue(undefined),
}));

import { Connection } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { checkRateLimit, verifyBridgeApiKey, verifyJwtToken } from '@server/cli/auth';
import { resolveBridgeWsAuth } from './ccAgentAuth';
import { toApiKeyAuthError } from '@bike4mind/server-utils/auth/apiKeyAuthFailure';
import { UnauthorizedError } from '@bike4mind/server-utils/utils/errors';

const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger;

const resolve = () =>
  resolveBridgeWsAuth({
    accessToken: 'jwt-token',
    connectionId: 'conn-1',
    endpoint: 'https://example.test/test',
    logger,
    handlerName: 'TEST',
  });

describe('resolveBridgeWsAuth JWT fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Connection.findOne).mockReturnValue({ lean: () => Promise.resolve({ userId: 'u1' }) } as never);
  });

  it('rate-limits the JWT path on the ws bucket, apart from the completions counter', async () => {
    await expect(resolve()).resolves.toEqual({ userId: 'u1', apiKeyId: null });

    expect(verifyJwtToken).toHaveBeenCalledWith('jwt-token', { requireApiAccess: true });
    expect(checkRateLimit).toHaveBeenCalledWith('u1', undefined, { bucket: 'ws' });
  });

  it('returns null when the JWT rate limit rejects', async () => {
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error('Rate limit exceeded'));

    await expect(resolve()).resolves.toBeNull();
  });
});

const databaseUnreachable = () =>
  toApiKeyAuthError(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:27017'), { name: 'MongoNetworkError' }));

describe('resolveBridgeWsAuth API-key check outcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Connection.findOne).mockReturnValue({ lean: () => Promise.resolve({ userId: 'u1' }) } as never);
  });

  it('throws the 503 when the database is unreachable, without trying the JWT', async () => {
    vi.mocked(verifyBridgeApiKey).mockRejectedValueOnce(databaseUnreachable());

    const error = await resolve().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ statusCode: 503, message: 'Authentication temporarily unavailable' });
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('ECONNREFUSED');
    expect(verifyJwtToken).not.toHaveBeenCalled();
  });

  it('propagates an unavailable live JWT access check as 503', async () => {
    vi.mocked(verifyJwtToken).mockRejectedValueOnce(databaseUnreachable());
    await expect(resolve()).rejects.toMatchObject({ statusCode: 503 });
  });

  it('resolves null for an unknown key that the JWT check also rejects', async () => {
    vi.mocked(verifyBridgeApiKey).mockRejectedValueOnce(new UnauthorizedError('Invalid or expired API key'));
    vi.mocked(verifyJwtToken).mockRejectedValueOnce(new Error('bad token'));

    await expect(resolve()).resolves.toBeNull();
    expect(verifyJwtToken).toHaveBeenCalled();
  });
});

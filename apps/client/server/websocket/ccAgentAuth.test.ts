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
import { checkRateLimit } from '@server/cli/auth';
import { resolveBridgeWsAuth } from './ccAgentAuth';

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

    expect(checkRateLimit).toHaveBeenCalledWith('u1', undefined, { bucket: 'ws' });
  });

  it('returns null when the JWT rate limit rejects', async () => {
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error('Rate limit exceeded'));

    await expect(resolve()).resolves.toBeNull();
  });
});

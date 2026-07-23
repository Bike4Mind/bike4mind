import { describe, it, expect, vi, beforeEach } from 'vitest';
import { API_KEY_RATE_LIMIT_MAX_PER_DAY, API_KEY_RATE_LIMIT_MAX_PER_MINUTE, updateApiKeyRateLimit } from './rateLimit';
import { IUserApiKeyDocument, IUserApiKeyRepository } from '@bike4mind/common';

const makeRepo = (stored: Partial<IUserApiKeyDocument> | null) =>
  ({
    findByUserIdAndId: vi.fn().mockResolvedValue(stored),
    setRateLimit: vi.fn().mockResolvedValue(undefined),
  }) as unknown as IUserApiKeyRepository;

const storedKey = (): Partial<IUserApiKeyDocument> => ({
  id: 'key-1',
  name: 'CLI key',
  rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
});

describe('userApiKeyService - updateApiKeyRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('raises one ceiling and leaves the other at its stored value', async () => {
    const repo = makeRepo(storedKey());

    const result = await updateApiKeyRateLimit(
      'user1',
      { keyId: 'key-1', requestsPerMinute: 600 },
      { db: { userApiKeys: repo } }
    );

    expect(result.rateLimit).toEqual({ requestsPerMinute: 600, requestsPerDay: 1000 });
    expect(repo.setRateLimit).toHaveBeenCalledWith('key-1', { requestsPerMinute: 600, requestsPerDay: 1000 });
  });

  it('updates both ceilings when both are sent', async () => {
    const repo = makeRepo(storedKey());

    const result = await updateApiKeyRateLimit(
      'user1',
      { keyId: 'key-1', requestsPerMinute: 5, requestsPerDay: 50 },
      { db: { userApiKeys: repo } }
    );

    expect(result.rateLimit).toEqual({ requestsPerMinute: 5, requestsPerDay: 50 });
  });

  // findByUserIdAndId is the authorization boundary: another user's key is
  // simply not found, so it can never be retargeted.
  it('rejects a key the caller does not own', async () => {
    const repo = makeRepo(null);

    await expect(
      updateApiKeyRateLimit('user2', { keyId: 'key-1', requestsPerMinute: 600 }, { db: { userApiKeys: repo } })
    ).rejects.toThrow(/API key not found/i);
    expect(repo.setRateLimit).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', { requestsPerMinute: 0 }],
    ['negative', { requestsPerDay: -1 }],
    ['fractional', { requestsPerMinute: 1.5 }],
    ['above the per-minute ceiling', { requestsPerMinute: API_KEY_RATE_LIMIT_MAX_PER_MINUTE + 1 }],
    ['above the per-day ceiling', { requestsPerDay: API_KEY_RATE_LIMIT_MAX_PER_DAY + 1 }],
  ])('rejects a %s value without writing', async (_label, patch) => {
    const repo = makeRepo(storedKey());

    await expect(
      updateApiKeyRateLimit('user1', { keyId: 'key-1', ...patch }, { db: { userApiKeys: repo } })
    ).rejects.toThrow();
    expect(repo.setRateLimit).not.toHaveBeenCalled();
  });

  it('rejects an update that specifies neither ceiling', async () => {
    const repo = makeRepo(storedKey());

    await expect(updateApiKeyRateLimit('user1', { keyId: 'key-1' }, { db: { userApiKeys: repo } })).rejects.toThrow(
      /At least one of/i
    );
    expect(repo.setRateLimit).not.toHaveBeenCalled();
  });

  it('accepts the exact ceilings', async () => {
    const repo = makeRepo(storedKey());

    const result = await updateApiKeyRateLimit(
      'user1',
      {
        keyId: 'key-1',
        requestsPerMinute: API_KEY_RATE_LIMIT_MAX_PER_MINUTE,
        requestsPerDay: API_KEY_RATE_LIMIT_MAX_PER_DAY,
      },
      { db: { userApiKeys: repo } }
    );

    expect(result.rateLimit).toEqual({
      requestsPerMinute: API_KEY_RATE_LIMIT_MAX_PER_MINUTE,
      requestsPerDay: API_KEY_RATE_LIMIT_MAX_PER_DAY,
    });
  });
});

import { describe, it, expect, vi } from 'vitest';
import { createUserApiKey } from '../create';
import { rotateUserApiKey } from '../rotate';
import { validateUserApiKey } from '../validate';
import { ApiKeyScope } from '@bike4mind/common';
import type { IUserApiKeyDocument } from '@bike4mind/common';
import { KEY_PREFIX_LENGTH } from '../constants';

vi.mock('bcryptjs', async () => {
  const { bcryptMockFactory } = await import('./helpers/bcryptMock');
  return bcryptMockFactory();
});

// Shared in-memory store that wires create / rotate / validate together
function makeSyncedRepo() {
  let stored: IUserApiKeyDocument | null = null;

  const repo = {
    countActiveByUserId: vi.fn().mockResolvedValue(0),
    countActiveByProductId: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation((doc: Record<string, unknown>) => {
      stored = { ...doc, id: 'key-1', createdAt: new Date() } as unknown as IUserApiKeyDocument;
      return Promise.resolve(stored);
    }),
    // rotate.ts mutates apiKey in place then calls update - the mutation lands on `stored` too
    findByUserIdAndId: vi.fn().mockImplementation(() => Promise.resolve(stored)),
    update: vi.fn().mockResolvedValue(undefined),
    findActiveByKeyPrefix: vi
      .fn()
      .mockImplementation((prefix: string) => Promise.resolve(stored?.keyPrefix === prefix ? stored : null)),
    updateLastUsed: vi.fn().mockResolvedValue(undefined),
  };

  return { repo, getStored: () => stored };
}

const mintParams = {
  name: 'test-key',
  scopes: [ApiKeyScope.OVERWATCH_INGEST_WRITE],
  metadata: { createdFrom: 'overwatch-admin' as const },
  productId: 'vibeswire',
};

describe('rotateUserApiKey — round-trip regression guard', () => {
  it('rotated key validates successfully and prefix length matches KEY_PREFIX_LENGTH', async () => {
    const { repo, getStored } = makeSyncedRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = { db: { userApiKeys: repo as any } };

    const { key: originalKey } = await createUserApiKey('sys-1', mintParams, {
      ...adapters,
      systemUserId: 'sys-1',
    });

    const { key: rotatedKey } = await rotateUserApiKey('sys-1', { keyId: 'key-1' }, adapters);

    expect(rotatedKey).not.toBe(originalKey);
    expect(rotatedKey).toMatch(/^b4m_live_/);

    // Regression guard: stored prefix must be KEY_PREFIX_LENGTH chars so validate can find it
    expect(getStored()!.keyPrefix).toHaveLength(KEY_PREFIX_LENGTH);
    expect(getStored()!.keyPrefix).toBe(rotatedKey.substring(0, KEY_PREFIX_LENGTH));

    const result = await validateUserApiKey(rotatedKey, adapters);
    expect(result.isValid).toBe(true);
    expect(result.keyId).toBe('key-1');
  });

  it('rotation preserves spendCap and accumulated spend (rotating the secret must not reset the meter)', async () => {
    const { repo, getStored } = makeSyncedRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = { db: { userApiKeys: repo as any } };

    await createUserApiKey(
      'sys-1',
      {
        name: 'embed-key',
        scopes: [ApiKeyScope.EMBED_CHAT],
        metadata: { createdFrom: 'dashboard' as const },
        agentId: 'agent-1',
        spendCap: 5000,
      },
      { ...adapters, systemUserId: 'sys-1' }
    );

    // Simulate spend accumulated before the rotation
    getStored()!.usage.totalSpendCredits = 4200;

    await rotateUserApiKey('sys-1', { keyId: 'key-1' }, adapters);

    expect(getStored()!.spendCap).toBe(5000);
    expect(getStored()!.usage.totalSpendCredits).toBe(4200);
  });

  it('original key is invalid after rotation', async () => {
    const { repo } = makeSyncedRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = { db: { userApiKeys: repo as any } };

    const { key: originalKey } = await createUserApiKey('sys-1', mintParams, {
      ...adapters,
      systemUserId: 'sys-1',
    });

    await rotateUserApiKey('sys-1', { keyId: 'key-1' }, adapters);

    const result = await validateUserApiKey(originalKey, adapters);
    expect(result.isValid).toBe(false);
  });
});

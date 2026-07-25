import { describe, it, expect, vi } from 'vitest';
import { createUserApiKey } from '../create';
import { revokeUserApiKey } from '../revoke';
import { ApiKeyScope, ApiKeyStatus, CreditHolderType } from '@bike4mind/common';
import type { IUserApiKeyDocument } from '@bike4mind/common';

vi.mock('bcryptjs', async () => {
  const { bcryptMockFactory } = await import('./helpers/bcryptMock');
  return bcryptMockFactory();
});

// In-memory store wiring create -> revoke so we can assert the status flip.
function makeSyncedRepo() {
  let stored: IUserApiKeyDocument | null = null;
  const repo = {
    countActiveByUserId: vi.fn().mockResolvedValue(0),
    countActiveByProductId: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation((doc: Record<string, unknown>) => {
      stored = { ...doc, id: 'key-1', createdAt: new Date() } as unknown as IUserApiKeyDocument;
      return Promise.resolve(stored);
    }),
    findByUserIdAndId: vi.fn().mockImplementation(() => Promise.resolve(stored)),
    update: vi.fn().mockResolvedValue(undefined),
  };
  return { repo, getStored: () => stored };
}

describe('revokeUserApiKey', () => {
  it('disables an embed:chat key while leaving its embed fields intact', async () => {
    const { repo, getStored } = makeSyncedRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = { db: { userApiKeys: repo as any } };

    await createUserApiKey(
      'user1',
      {
        name: 'Embed key',
        scopes: [ApiKeyScope.EMBED_CHAT],
        metadata: { createdFrom: 'dashboard' as const },
        agentId: 'agent-1',
        billingOwnerType: CreditHolderType.Organization,
        organizationId: 'org-1',
        allowedOrigins: ['https://example.com'],
      },
      adapters
    );

    await revokeUserApiKey('user1', { keyId: 'key-1' }, adapters);

    expect(getStored()!.status).toBe(ApiKeyStatus.DISABLED);
    expect(getStored()!.agentId).toBe('agent-1');
  });

  it('records the revocation audit trail and returns the key name', async () => {
    const { repo, getStored } = makeSyncedRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = { db: { userApiKeys: repo as any } };

    await createUserApiKey(
      'user1',
      { name: 'CI key', scopes: [ApiKeyScope.AI_GENERATE], metadata: { createdFrom: 'dashboard' as const } },
      adapters
    );

    const before = Date.now();
    const result = await revokeUserApiKey('user1', { keyId: 'key-1', reason: 'Leaked in a build log' }, adapters);

    expect(result.name).toBe('CI key');
    expect(getStored()!.revokedBy).toBe('user1');
    expect(getStored()!.revokedReason).toBe('Leaked in a build log');
    expect(getStored()!.revokedAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('leaves revokedReason unset when no reason is supplied', async () => {
    const { repo, getStored } = makeSyncedRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = { db: { userApiKeys: repo as any } };

    await createUserApiKey(
      'user1',
      { name: 'CI key', scopes: [ApiKeyScope.AI_GENERATE], metadata: { createdFrom: 'dashboard' as const } },
      adapters
    );

    await revokeUserApiKey('user1', { keyId: 'key-1' }, adapters);

    expect(getStored()!.revokedAt).toBeInstanceOf(Date);
    expect(getStored()!.revokedReason).toBeUndefined();
  });

  it('keeps the first revocation when an already-revoked key is revoked again', async () => {
    const { repo, getStored } = makeSyncedRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = { db: { userApiKeys: repo as any } };

    await createUserApiKey(
      'user1',
      { name: 'CI key', scopes: [ApiKeyScope.AI_GENERATE], metadata: { createdFrom: 'dashboard' as const } },
      adapters
    );

    await revokeUserApiKey('user1', { keyId: 'key-1', reason: 'Leaked in a build log' }, adapters);
    const firstRevokedAt = getStored()!.revokedAt;

    await revokeUserApiKey('user1', { keyId: 'key-1', reason: 'Second attempt' }, adapters);

    expect(getStored()!.revokedAt).toBe(firstRevokedAt);
    expect(getStored()!.revokedReason).toBe('Leaked in a build log');
  });
});

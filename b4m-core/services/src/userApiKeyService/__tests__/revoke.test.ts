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
        allowedOrigins: ['https://example.com'],
        organizationId: 'org-1',
        billingOwnerType: CreditHolderType.Organization,
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

  // #909: an org admin can revoke a key billed to an org they administer, even a
  // key they did not mint - resolved via the org-admin fallback.
  describe('org-admin revoke (#909)', () => {
    const orgKey = () =>
      ({
        id: 'key-1',
        name: 'Org embed key',
        userId: 'minter',
        status: ApiKeyStatus.ACTIVE,
      }) as unknown as IUserApiKeyDocument;

    it('revokes a teammate org key and stamps revokedBy to the acting admin (not the minter)', async () => {
      const stored = orgKey();
      const repo = {
        findByUserIdAndId: vi.fn().mockResolvedValue(null),
        findByOrganizationIdsAndId: vi.fn().mockResolvedValue(stored),
        update: vi.fn().mockResolvedValue(undefined),
      };
      const orgs = { findIdsAdministeredBy: vi.fn().mockResolvedValue(['org-1']) };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapters = { db: { userApiKeys: repo as any, organizations: orgs as any } };

      await revokeUserApiKey('admin-user', { keyId: 'key-1' }, adapters);

      expect(orgs.findIdsAdministeredBy).toHaveBeenCalledWith('admin-user');
      expect(repo.findByOrganizationIdsAndId).toHaveBeenCalledWith(['org-1'], 'key-1');
      expect(stored.status).toBe(ApiKeyStatus.DISABLED);
      expect(stored.revokedBy).toBe('admin-user');
    });

    it('throws NotFound when the caller neither minted nor administers the key', async () => {
      const repo = {
        findByUserIdAndId: vi.fn().mockResolvedValue(null),
        findByOrganizationIdsAndId: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue(undefined),
      };
      const orgs = { findIdsAdministeredBy: vi.fn().mockResolvedValue([]) };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapters = { db: { userApiKeys: repo as any, organizations: orgs as any } };

      await expect(revokeUserApiKey('other-user', { keyId: 'key-1' }, adapters)).rejects.toThrow(/not found/);
      expect(repo.update).not.toHaveBeenCalled();
    });
  });
});

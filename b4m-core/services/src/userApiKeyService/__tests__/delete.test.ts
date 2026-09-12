import { describe, it, expect, vi } from 'vitest';
import { deleteUserApiKey } from '../delete';
import { ApiKeyStatus } from '@bike4mind/common';
import type { IUserApiKeyDocument } from '@bike4mind/common';

const keyDoc = (overrides: Partial<IUserApiKeyDocument> = {}) =>
  ({
    id: 'key-1',
    name: 'CI key',
    userId: 'user1',
    status: ApiKeyStatus.DISABLED,
    ...overrides,
  }) as unknown as IUserApiKeyDocument;

function makeAdapters(stored: IUserApiKeyDocument | null, administeredOrgIds: string[] = []) {
  const repo = {
    findByUserIdAndId: vi.fn().mockResolvedValue(stored?.userId === 'user1' ? stored : null),
    findByOrganizationIdsAndId: vi.fn().mockResolvedValue(stored?.userId === 'user1' ? null : stored),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const orgs = { findIdsAdministeredBy: vi.fn().mockResolvedValue(administeredOrgIds) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { repo, orgs, adapters: { db: { userApiKeys: repo as any, organizations: orgs as any } } };
}

describe('deleteUserApiKey', () => {
  it('deletes a revoked key the caller minted and returns its name', async () => {
    const { repo, adapters } = makeAdapters(keyDoc());

    const result = await deleteUserApiKey('user1', { keyId: 'key-1' }, adapters);

    expect(result.name).toBe('CI key');
    expect(repo.delete).toHaveBeenCalledWith('key-1');
  });

  it('refuses to delete an active key so revocation always precedes removal', async () => {
    const { repo, adapters } = makeAdapters(keyDoc({ status: ApiKeyStatus.ACTIVE }));

    await expect(deleteUserApiKey('user1', { keyId: 'key-1' }, adapters)).rejects.toThrow(/Revoke this API key/);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  // An expired key stays ACTIVE until something revokes it (status is not
  // clock-derived), so it too must be revoked first - no clock in this guard.
  it('refuses to delete an expired-but-active key', async () => {
    const { repo, adapters } = makeAdapters(keyDoc({ status: ApiKeyStatus.ACTIVE, expiresAt: new Date('2020-01-01') }));

    await expect(deleteUserApiKey('user1', { keyId: 'key-1' }, adapters)).rejects.toThrow(/Revoke this API key/);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('lets an org admin delete a revoked key billed to an org they administer', async () => {
    const { repo, orgs, adapters } = makeAdapters(keyDoc({ userId: 'minter', name: 'Org key' }), ['org-1']);

    const result = await deleteUserApiKey('admin-user', { keyId: 'key-1' }, adapters);

    expect(result.name).toBe('Org key');
    expect(orgs.findIdsAdministeredBy).toHaveBeenCalledWith('admin-user');
    expect(repo.findByOrganizationIdsAndId).toHaveBeenCalledWith(['org-1'], 'key-1');
    expect(repo.delete).toHaveBeenCalledWith('key-1');
  });

  it('throws NotFound when the caller neither minted nor administers the key', async () => {
    const { repo, adapters } = makeAdapters(null);

    await expect(deleteUserApiKey('other-user', { keyId: 'key-1' }, adapters)).rejects.toThrow(/not found/);
    expect(repo.delete).not.toHaveBeenCalled();
  });
});

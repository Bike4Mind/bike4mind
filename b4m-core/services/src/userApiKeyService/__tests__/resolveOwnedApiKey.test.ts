import { describe, it, expect, vi } from 'vitest';
import { resolveOwnedApiKey } from '../resolveOwnedApiKey';
import type { IUserApiKeyDocument } from '@bike4mind/common';

function makeAdapters(minted: IUserApiKeyDocument | null, orgMatch: IUserApiKeyDocument | null) {
  const userApiKeys = {
    findByUserIdAndId: vi.fn().mockResolvedValue(minted),
    findByOrganizationIdsAndId: vi.fn().mockResolvedValue(orgMatch),
  };
  const organizations = {
    findIdsAdministeredBy: vi.fn().mockResolvedValue(['org-1']),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { userApiKeys: userApiKeys as any, organizations: organizations as any } };
}

describe('resolveOwnedApiKey', () => {
  it('returns the minter match without querying org admin', async () => {
    const key = { id: 'key-1' } as IUserApiKeyDocument;
    const adapters = makeAdapters(key, null);

    const result = await resolveOwnedApiKey('minter', 'key-1', adapters);

    expect(result).toBe(key);
    expect(adapters.db.organizations.findIdsAdministeredBy).not.toHaveBeenCalled();
  });

  it('falls back to the org-admin match on a minter miss', async () => {
    const orgKey = { id: 'key-1' } as IUserApiKeyDocument;
    const adapters = makeAdapters(null, orgKey);

    const result = await resolveOwnedApiKey('admin-user', 'key-1', adapters);

    expect(result).toBe(orgKey);
    expect(adapters.db.organizations.findIdsAdministeredBy).toHaveBeenCalledWith('admin-user');
    expect(adapters.db.userApiKeys.findByOrganizationIdsAndId).toHaveBeenCalledWith(['org-1'], 'key-1');
  });

  it('returns null when neither the minter nor an administered org matches', async () => {
    const adapters = makeAdapters(null, null);

    const result = await resolveOwnedApiKey('other-user', 'key-1', adapters);

    expect(result).toBeNull();
  });

  it('returns null for a falsy userId without querying either repository', async () => {
    const adapters = makeAdapters(null, null);

    const result = await resolveOwnedApiKey('', 'key-1', adapters);

    expect(result).toBeNull();
    expect(adapters.db.userApiKeys.findByUserIdAndId).not.toHaveBeenCalled();
    expect(adapters.db.organizations.findIdsAdministeredBy).not.toHaveBeenCalled();
  });
});

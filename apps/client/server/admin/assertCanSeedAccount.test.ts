// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

vi.mock('@client/lib/entitlements/managedUserTags', () => ({ isManagedTag: (tag: string) => tag === 'managed' }));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { findGateValues: async () => ({ userTags: ['lake-gate'], entitlements: [] }) },
}));

import { assertCanSeedAccount } from './assertCanSeedAccount';

const delegate = (...adminPermissions: string[]) => ({ user: { isAdmin: false, adminPermissions } });
const fullAdmin = { user: { isAdmin: true } };

describe('assertCanSeedAccount', () => {
  it('lets a delegate create a plain account with no credits and unmanaged tags', async () => {
    await expect(assertCanSeedAccount(delegate('settings:manage'), { credits: 0, tags: ['beta'] })).resolves.toBe(
      undefined
    );
  });

  it('requires credits:adjust to seed credits', async () => {
    await expect(assertCanSeedAccount(delegate('settings:manage'), { credits: 5 })).rejects.toThrow(
      'Missing permission: credits:adjust'
    );
    await expect(
      assertCanSeedAccount(delegate('settings:manage', 'credits:adjust'), { credits: 5 })
    ).resolves.toBeUndefined();
  });

  it('keeps managed tags, lake gate tags and the admin role to full admins', async () => {
    const all = delegate('settings:manage', 'credits:adjust', 'support:read');
    await expect(assertCanSeedAccount(all, { tags: ['beta', 'managed'] })).rejects.toThrow('managed tags');
    await expect(assertCanSeedAccount(all, { tags: ['beta', 'Lake-Gate'] })).rejects.toThrow('data lake access');
    await expect(assertCanSeedAccount(all, { isAdmin: true })).rejects.toThrow('full admin access');
    await expect(
      assertCanSeedAccount(fullAdmin, { isAdmin: true, credits: 5, tags: ['managed', 'lake-gate'] })
    ).resolves.toBeUndefined();
  });
});

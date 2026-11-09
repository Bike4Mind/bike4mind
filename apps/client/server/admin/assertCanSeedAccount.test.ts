// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

vi.mock('@client/lib/entitlements/managedUserTags', () => ({ isManagedTag: (tag: string) => tag === 'managed' }));

import { assertCanSeedAccount } from './assertCanSeedAccount';

const delegate = (...adminPermissions: string[]) => ({ user: { isAdmin: false, adminPermissions } });
const fullAdmin = { user: { isAdmin: true } };

describe('assertCanSeedAccount', () => {
  it('lets a delegate create a plain account with no credits and unmanaged tags', () => {
    expect(() => assertCanSeedAccount(delegate('settings:manage'), { credits: 0, tags: ['beta'] })).not.toThrow();
  });

  it('requires credits:adjust to seed credits', () => {
    expect(() => assertCanSeedAccount(delegate('settings:manage'), { credits: 5 })).toThrow(
      'Missing permission: credits:adjust'
    );
    expect(() => assertCanSeedAccount(delegate('settings:manage', 'credits:adjust'), { credits: 5 })).not.toThrow();
  });

  it('keeps managed tags and the admin role to full admins', () => {
    const all = delegate('settings:manage', 'credits:adjust', 'support:read');
    expect(() => assertCanSeedAccount(all, { tags: ['beta', 'managed'] })).toThrow('managed tags');
    expect(() => assertCanSeedAccount(all, { isAdmin: true })).toThrow('full admin access');
    expect(() => assertCanSeedAccount(fullAdmin, { isAdmin: true, credits: 5, tags: ['managed'] })).not.toThrow();
  });
});

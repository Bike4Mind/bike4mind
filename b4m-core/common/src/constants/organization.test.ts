import { describe, it, expect } from 'vitest';
import { canManageMemberCreditBudgets, isOrgOwnerOrCurrentAdmin } from './organization';

describe('isOrgOwnerOrCurrentAdmin', () => {
  const org = {
    userId: 'owner-id',
    adminUserIds: ['org-admin-id', 'stale-admin-id'],
    users: [{ userId: 'org-admin-id' }, { userId: 'member-id' }, { userId: 'manager-id' }],
  };

  it('is the predicate behind canManageMemberCreditBudgets', () => {
    expect(canManageMemberCreditBudgets).toBe(isOrgOwnerOrCurrentAdmin);
  });

  it('admits the billing owner even without a users[] row', () => {
    expect(isOrgOwnerOrCurrentAdmin({ id: 'owner-id' }, org)).toBe(true);
  });

  it('admits an appointed org admin who is still on the roster', () => {
    expect(isOrgOwnerOrCurrentAdmin({ id: 'org-admin-id' }, org)).toBe(true);
  });

  it('admits a platform admin who is neither', () => {
    expect(isOrgOwnerOrCurrentAdmin({ id: 'someone-else', isAdmin: true }, org)).toBe(true);
  });

  it('refuses a stale adminUserIds entry with no users[] row', () => {
    expect(isOrgOwnerOrCurrentAdmin({ id: 'stale-admin-id' }, org)).toBe(false);
  });

  // A spending limit on the owner's pool is a billing decision, like billingContact.
  it('refuses a manager who is not also an appointed admin', () => {
    expect(isOrgOwnerOrCurrentAdmin({ id: 'manager-id' }, { ...org, managerId: 'manager-id' })).toBe(false);
  });

  it('refuses a plain member', () => {
    expect(isOrgOwnerOrCurrentAdmin({ id: 'member-id' }, org)).toBe(false);
  });

  it('tolerates a missing adminUserIds or users', () => {
    expect(isOrgOwnerOrCurrentAdmin({ id: 'member-id' }, { userId: 'owner-id', adminUserIds: null })).toBe(false);
    expect(
      isOrgOwnerOrCurrentAdmin({ id: 'org-admin-id' }, { userId: 'owner-id', adminUserIds: ['org-admin-id'] })
    ).toBe(false);
    expect(isOrgOwnerOrCurrentAdmin({ id: 'org-admin-id' }, { userId: 'owner-id', users: null })).toBe(false);
  });
});

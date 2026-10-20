import { describe, it, expect } from 'vitest';
import {
  canAdministerOrganization,
  canManageMemberCreditBudgets,
  canRevokeOrgMember,
  isOrgOwnerOrCurrentAdmin,
} from './organization';

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

describe('canAdministerOrganization', () => {
  const org = { userId: 'owner-id', managerId: 'manager-id' };

  it('admits the billing owner', () => {
    expect(canAdministerOrganization({ id: 'owner-id' }, org)).toBe(true);
  });

  it('admits the appointed manager', () => {
    expect(canAdministerOrganization({ id: 'manager-id' }, org)).toBe(true);
  });

  it('admits a platform admin who is neither', () => {
    expect(canAdministerOrganization({ id: 'someone-else', isAdmin: true }, org)).toBe(true);
  });

  // The finding this predicate exists for: roster administration used to gate on the membership
  // ACL, which every ordinary member satisfies.
  it('refuses a plain member', () => {
    expect(canAdministerOrganization({ id: 'member-id' }, org)).toBe(false);
  });

  it('refuses a stranger', () => {
    expect(canAdministerOrganization({ id: 'nobody' }, org)).toBe(false);
  });

  // A null managerId must not match a caller whose id is somehow also nullish - fail closed on a
  // blank identity rather than admitting on `undefined === undefined`.
  it('does not admit on a null managerId', () => {
    expect(
      canAdministerOrganization({ id: undefined as unknown as string }, { userId: 'owner-id', managerId: null })
    ).toBe(false);
  });

  it('refuses a non-owner when the org has no managerId', () => {
    expect(canAdministerOrganization({ id: 'manager-id' }, { userId: 'owner-id' })).toBe(false);
  });

  it('does not admit on an empty-string managerId', () => {
    expect(canAdministerOrganization({ id: '' }, { userId: 'owner-id', managerId: '' })).toBe(false);
  });

  it('refuses an explicit isAdmin false or null', () => {
    expect(canAdministerOrganization({ id: 'member-id', isAdmin: false }, org)).toBe(false);
    expect(canAdministerOrganization({ id: 'member-id', isAdmin: null }, org)).toBe(false);
  });

  it('admits an org manager (adminUserIds) who is still on the roster', () => {
    const roster = { ...org, adminUserIds: ['org-admin-id'], users: [{ userId: 'org-admin-id' }] };
    expect(canAdministerOrganization({ id: 'org-admin-id' }, roster)).toBe(true);
  });

  it('refuses a stale adminUserIds entry with no users[] row', () => {
    const roster = { ...org, adminUserIds: ['org-admin-id'], users: [] };
    expect(canAdministerOrganization({ id: 'org-admin-id' }, roster)).toBe(false);
  });

  // The legacy single managerId is the only actor that passes this but not isOrgOwnerOrCurrentAdmin.
  it('is a superset of isOrgOwnerOrCurrentAdmin only by the legacy managerId', () => {
    const roster = { ...org, adminUserIds: ['org-admin-id'], users: [{ userId: 'org-admin-id' }] };
    expect(canAdministerOrganization({ id: 'manager-id' }, roster)).toBe(true);
    expect(isOrgOwnerOrCurrentAdmin({ id: 'manager-id' }, roster)).toBe(false);
    expect(canAdministerOrganization({ id: 'org-admin-id' }, roster)).toBe(true);
    expect(isOrgOwnerOrCurrentAdmin({ id: 'org-admin-id' }, roster)).toBe(true);
  });
});

describe('canRevokeOrgMember', () => {
  const org = {
    userId: 'owner-id',
    managerId: 'legacy-id',
    adminUserIds: ['mgr-id'],
    users: [{ userId: 'mgr-id' }, { userId: 'member-id' }],
  };

  it.each([
    ['platform admin', { id: 'root', isAdmin: true }, 'mgr-id', true],
    ['owner', { id: 'owner-id' }, 'legacy-id', true],
    ['owner', { id: 'owner-id' }, 'mgr-id', true],
    ['roster manager', { id: 'mgr-id' }, 'legacy-id', false],
    ['roster manager', { id: 'mgr-id' }, 'mgr-id', false],
    ['roster manager', { id: 'mgr-id' }, 'member-id', true],
    ['legacy manager', { id: 'legacy-id' }, 'mgr-id', false],
    ['legacy manager', { id: 'legacy-id' }, 'member-id', true],
    ['plain member', { id: 'member-id' }, 'member-id', false],
  ])('%s revoking %s target %s -> %s', (_label, actor, target, expected) => {
    expect(canRevokeOrgMember(actor, org, target)).toBe(expected);
  });

  it('refuses a manager who is no longer on the roster, whoever the target is', () => {
    const stale = { ...org, users: [{ userId: 'member-id' }] };
    expect(canRevokeOrgMember({ id: 'mgr-id' }, stale, 'member-id')).toBe(false);
  });
});

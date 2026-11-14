import { describe, it, expect } from 'vitest';
import {
  canAdministerOrganization,
  canAssignOrgRole,
  canManageMemberCreditBudgets,
  canRevokeOrgMember,
  isOrgOwnerOrCurrentAdmin,
  organizationSeatUsage,
  organizationSeatsFullMessage,
} from './organization';

describe('isOrgOwnerOrCurrentAdmin', () => {
  const org = {
    userId: 'owner-id',
    adminUserIds: ['org-admin-id', 'stale-admin-id'],
    users: [{ userId: 'org-admin-id' }, { userId: 'member-id' }, { userId: 'manager-id' }],
  };

  it('gives canManageMemberCreditBudgets the same answer for every pre-roles actor', () => {
    for (const id of ['owner-id', 'org-admin-id', 'stale-admin-id', 'member-id', 'stranger-id']) {
      expect(canManageMemberCreditBudgets({ id }, org)).toBe(isOrgOwnerOrCurrentAdmin({ id }, org));
    }
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
    expect(isOrgOwnerOrCurrentAdmin({ id: 'manager-id' }, org)).toBe(false);
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
  const org = {
    userId: 'owner-id',
    adminUserIds: ['manager-id'],
    users: [{ userId: 'manager-id' }],
  };

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

  it('does not admit a blank caller id', () => {
    expect(canAdministerOrganization({ id: undefined as unknown as string }, { userId: 'owner-id' })).toBe(false);
    expect(canAdministerOrganization({ id: '' }, { userId: 'owner-id' })).toBe(false);
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

  it('agrees with isOrgOwnerOrCurrentAdmin', () => {
    const actors = [{ id: 'manager-id' }, { id: 'owner-id' }, { id: 'member-id' }, { id: 'x', isAdmin: true }];
    for (const actor of actors) {
      expect(canAdministerOrganization(actor, org)).toBe(isOrgOwnerOrCurrentAdmin(actor, org));
    }
  });
});

describe('canRevokeOrgMember', () => {
  const org = {
    userId: 'owner-id',
    adminUserIds: ['mgr-id'],
    users: [{ userId: 'mgr-id' }, { userId: 'member-id' }],
  };

  it.each([
    ['platform admin', { id: 'root', isAdmin: true }, 'mgr-id', true],
    ['owner', { id: 'owner-id' }, 'mgr-id', true],
    ['roster manager', { id: 'mgr-id' }, 'mgr-id', false],
    ['roster manager', { id: 'mgr-id' }, 'member-id', true],
    ['plain member', { id: 'member-id' }, 'member-id', false],
  ])('%s revoking %s target %s -> %s', (_label, actor, target, expected) => {
    expect(canRevokeOrgMember(actor, org, target)).toBe(expected);
  });

  it('refuses a manager who is no longer on the roster, whoever the target is', () => {
    const stale = { ...org, users: [{ userId: 'member-id' }] };
    expect(canRevokeOrgMember({ id: 'mgr-id' }, stale, 'member-id')).toBe(false);
  });

  it('leaves a billing manager for the owner to remove', () => {
    const withBilling = {
      ...org,
      billingManagerUserIds: ['billing-id'],
      users: [...org.users, { userId: 'billing-id' }],
    };
    expect(canRevokeOrgMember({ id: 'mgr-id' }, withBilling, 'billing-id')).toBe(false);
    expect(canRevokeOrgMember({ id: 'owner-id' }, withBilling, 'billing-id')).toBe(true);
    expect(canRevokeOrgMember({ id: 'billing-id' }, withBilling, 'member-id')).toBe(false);
  });

  it('lets a manager revoke a pending invitee, who has no users[] row yet', () => {
    expect(canRevokeOrgMember({ id: 'mgr-id' }, org, 'invitee-id')).toBe(true);
  });
});

describe('canAssignOrgRole', () => {
  const roles = {
    userId: 'owner',
    adminUserIds: ['manager', 'manager-2'],
    billingManagerUserIds: ['billing'],
    users: [{ userId: 'manager' }, { userId: 'manager-2' }, { userId: 'billing' }, { userId: 'member' }],
  };
  const owner = { id: 'owner' };
  const manager = { id: 'manager' };
  const billing = { id: 'billing' };
  const member = { id: 'member' };
  const platformAdmin = { id: 'outsider', isAdmin: true };

  it.each([
    ['the owner', owner, 'member', 'billingManager', true],
    ['the owner', owner, 'manager-2', 'member', true],
    ['the owner', owner, 'billing', 'manager', true],
    ['a platform admin', platformAdmin, 'member', 'billingManager', true],
    ['a manager', manager, 'member', 'manager', true],
    ['a manager', manager, 'member', 'billingManager', false],
    ['a manager', manager, 'manager-2', 'member', false],
    ['a manager', manager, 'billing', 'member', false],
    ['a manager', manager, 'manager', 'member', false],
    ['a billing manager', billing, 'member', 'billingManager', false],
    ['a member', member, 'member', 'manager', false],
  ] as const)('%s giving %s the role %s -> %s', (_label, actor, target, role, expected) => {
    expect(canAssignOrgRole(actor, roles, target, role)).toBe(expected);
  });

  it('never assigns a role to the owner or to someone off the roster', () => {
    expect(canAssignOrgRole(owner, roles, 'owner', 'member')).toBe(false);
    expect(canAssignOrgRole(platformAdmin, roles, 'invitee', 'manager')).toBe(false);
  });

  it('refuses a manager whose own roster row is gone', () => {
    expect(canAssignOrgRole(manager, { ...roles, users: [{ userId: 'member' }] }, 'member', 'manager')).toBe(false);
  });
});

describe('organizationSeatUsage', () => {
  it('counts the owner, who holds a seat without a users[] row', () => {
    expect(organizationSeatUsage({ users: [{}, {}], seats: 10 })).toEqual({ used: 3, seats: 10, full: false });
  });

  it('is not full one seat below capacity', () => {
    expect(organizationSeatUsage({ users: new Array(8).fill({}), seats: 10 })).toMatchObject({
      used: 9,
      full: false,
    });
  });

  it('is full once owner plus members reach the paid seats', () => {
    expect(organizationSeatUsage({ users: new Array(9).fill({}), seats: 10 })).toMatchObject({ used: 10, full: true });
    expect(organizationSeatUsage({ users: new Array(12).fill({}), seats: 10 }).full).toBe(true);
  });

  it('treats a missing roster as the owner alone', () => {
    expect(organizationSeatUsage({ users: null, seats: 1 })).toEqual({ used: 1, seats: 1, full: true });
  });
});

describe('organizationSeatsFullMessage', () => {
  it('says "its only paid seat" for a one-seat org', () => {
    expect(organizationSeatsFullMessage('Acme', 1)).toBe(
      'Acme uses its only paid seat. Raise the seat count on its profile before adding anyone.'
    );
  });

  it('counts the seats otherwise', () => {
    expect(organizationSeatsFullMessage('Acme', 3)).toBe(
      'Acme uses all 3 paid seats. Raise the seat count on its profile before adding anyone.'
    );
  });
});

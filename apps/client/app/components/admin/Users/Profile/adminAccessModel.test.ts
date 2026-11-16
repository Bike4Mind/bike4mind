import { describe, expect, it } from 'vitest';
import { describeProvenance, permissionProvenance, roleGrantBlockedReason } from './adminAccessModel';

const SUPPORT_AGENT = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  name: 'Support agent',
  permissions: ['support:read', 'users:moderate'] as const,
};
const BILLING = {
  id: 'BBBBBBBBBBBBBBBBBBBBBBBB',
  name: 'Billing',
  permissions: ['support:read', 'credits:adjust'] as const,
};
const ROLES = [
  { ...SUPPORT_AGENT, permissions: [...SUPPORT_AGENT.permissions] },
  { ...BILLING, permissions: [...BILLING.permissions] },
];

describe('permissionProvenance', () => {
  it('unions direct grants and role permissions in canonical order, naming every source', () => {
    expect(permissionProvenance(['users:moderate', 'keys:revoke'], [SUPPORT_AGENT.id, BILLING.id], ROLES)).toEqual([
      { id: 'support:read', direct: false, roleNames: ['Support agent', 'Billing'] },
      { id: 'credits:adjust', direct: false, roleNames: ['Billing'] },
      { id: 'users:moderate', direct: true, roleNames: ['Support agent'] },
      { id: 'keys:revoke', direct: true, roleNames: [] },
    ]);
  });

  it('grants nothing for a role id that names no role', () => {
    expect(permissionProvenance([], ['cccccccccccccccccccccccc'], ROLES)).toEqual([]);
  });

  it('matches role ids case-insensitively', () => {
    expect(permissionProvenance([], [BILLING.id.toLowerCase()], ROLES).map(entry => entry.id)).toEqual([
      'support:read',
      'credits:adjust',
    ]);
  });
});

describe('describeProvenance', () => {
  it('says where each permission comes from, both sources included', () => {
    expect(describeProvenance({ direct: false, roleNames: ['Support agent'] })).toBe('from Support agent');
    expect(describeProvenance({ direct: true, roleNames: [] })).toBe('granted directly');
    expect(describeProvenance({ direct: true, roleNames: ['Support agent', 'Billing'] })).toBe(
      'from Support agent, Billing; granted directly'
    );
  });
});

describe('roleGrantBlockedReason', () => {
  it('never blocks a full admin', () => {
    expect(roleGrantBlockedReason({ isAdmin: true }, ROLES[1])).toBeNull();
  });

  it('blocks a delegate from a role carrying a permission they lack, counting their own roles', () => {
    const delegate = { adminPermissions: ['support:read'], roleAdminPermissions: ['users:moderate'] };
    expect(roleGrantBlockedReason(delegate, ROLES[0])).toBeNull();
    expect(roleGrantBlockedReason(delegate, ROLES[1])).toBe('You do not hold credits:adjust');
  });
});

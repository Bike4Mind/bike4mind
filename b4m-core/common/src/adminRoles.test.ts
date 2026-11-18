import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSIONS,
  type AdminPermissionId,
  AdminUserPermissionsChangeSchema,
  assertCanActOnAdminTarget,
  canAccessAdmin,
  hasAdminPermission,
  meetsAdminPermissionRequirement,
} from './adminPermissions';
import {
  ADMIN_ROLE_TEMPLATES,
  AdminRoleCreateSchema,
  AdminRoleUpdateSchema,
  adminPermissionSources,
  formatAdminPermissionSource,
} from './adminRoles';
import { sortAdminPermissions } from './adminPermissions';

const ROLE_ID = 'a'.repeat(24);

describe('admin role templates', () => {
  it.each(ADMIN_ROLE_TEMPLATES)('$id carries only real admin permissions', template => {
    expect(template.permissions.length).toBeGreaterThan(0);
    for (const permission of template.permissions) expect(ADMIN_PERMISSIONS).toContain(permission);
  });

  it('has unique ids and names', () => {
    expect(new Set(ADMIN_ROLE_TEMPLATES.map(template => template.id)).size).toBe(ADMIN_ROLE_TEMPLATES.length);
    expect(new Set(ADMIN_ROLE_TEMPLATES.map(template => template.name)).size).toBe(ADMIN_ROLE_TEMPLATES.length);
  });

  it('puts the destructive permissions in no template', () => {
    const templated = new Set<AdminPermissionId>(ADMIN_ROLE_TEMPLATES.flatMap(template => template.permissions));
    for (const permission of ['users:delete', 'users:impersonate', 'users:export'] as const) {
      expect(templated.has(permission)).toBe(false);
    }
  });

  it('is a valid create body as is', () => {
    for (const template of ADMIN_ROLE_TEMPLATES) {
      expect(
        AdminRoleCreateSchema.safeParse({ name: template.name, permissions: [...template.permissions] }).success
      ).toBe(true);
    }
  });
});

describe('AdminRoleCreateSchema', () => {
  it('sorts permissions into ADMIN_PERMISSIONS order and defaults the description', () => {
    expect(AdminRoleCreateSchema.parse({ name: ' Support ', permissions: ['users:moderate', 'support:read'] })).toEqual(
      { name: 'Support', description: '', permissions: ['support:read', 'users:moderate'] }
    );
  });

  it.each([
    ['no permissions', { name: 'Empty', permissions: [] }],
    ['an unknown permission', { name: 'Bad', permissions: ['root'] }],
    ['a repeated permission', { name: 'Twice', permissions: ['support:read', 'support:read'] }],
    ['a blank name', { name: '  ', permissions: ['support:read'] }],
    ['the full-admin flag', { name: 'Root', permissions: ['support:read'], isAdmin: true }],
  ])('rejects %s', (_label, body) => {
    expect(AdminRoleCreateSchema.safeParse(body).success).toBe(false);
  });
});

describe('AdminRoleUpdateSchema', () => {
  it('rejects an empty patch and an emptied permission list', () => {
    expect(AdminRoleUpdateSchema.safeParse({}).success).toBe(false);
    expect(AdminRoleUpdateSchema.safeParse({ permissions: [] }).success).toBe(false);
  });

  it('accepts a rename alone', () => {
    expect(AdminRoleUpdateSchema.parse({ name: 'Billing team' })).toEqual({ name: 'Billing team' });
  });

  it('takes an optional reason, but a reason alone is not a change', () => {
    expect(AdminRoleUpdateSchema.parse({ name: 'Billing team', reason: ' New hire onboarding ' })).toEqual({
      name: 'Billing team',
      reason: 'New hire onboarding',
    });
    expect(AdminRoleUpdateSchema.safeParse({ reason: 'New hire onboarding' }).success).toBe(false);
    expect(AdminRoleUpdateSchema.safeParse({ name: 'Billing team', reason: 'no' }).success).toBe(false);
  });
});

describe('effective permissions with roles', () => {
  it('unions direct grants with role permissions', () => {
    const user = { adminPermissions: ['support:read'], roleAdminPermissions: ['credits:adjust'] };
    expect(hasAdminPermission(user, 'support:read')).toBe(true);
    expect(hasAdminPermission(user, 'credits:adjust')).toBe(true);
    expect(hasAdminPermission(user, 'users:delete')).toBe(false);
    expect(meetsAdminPermissionRequirement(user, ['users:delete', 'credits:adjust'])).toBe(true);
  });

  it('behaves as before for a user with no roles', () => {
    expect(hasAdminPermission({ adminPermissions: ['support:read'] }, 'credits:adjust')).toBe(false);
    expect(canAccessAdmin({ adminPermissions: [] })).toBe(false);
    expect(canAccessAdmin({})).toBe(false);
  });

  it('counts role membership as admin access even before roles are resolved', () => {
    const target = { adminPermissions: [], adminRoleIds: [ROLE_ID] };
    expect(canAccessAdmin(target)).toBe(true);
    expect(() => assertCanActOnAdminTarget({ adminPermissions: ['users:moderate'] }, target, 'suspend')).toThrow(
      'Only full administrators can suspend users with admin access'
    );
    expect(() => assertCanActOnAdminTarget({ isAdmin: true }, target, 'suspend')).not.toThrow();
  });
});

describe('AdminUserPermissionsChangeSchema role fields', () => {
  const base = { before: [], adminPermissions: [], reason: 'onboarding' };

  it('stays valid without role fields', () => {
    expect(AdminUserPermissionsChangeSchema.safeParse(base).success).toBe(true);
  });

  it('requires beforeAdminRoleIds and adminRoleIds together', () => {
    expect(AdminUserPermissionsChangeSchema.safeParse({ ...base, adminRoleIds: [ROLE_ID] }).success).toBe(false);
    expect(
      AdminUserPermissionsChangeSchema.safeParse({ ...base, beforeAdminRoleIds: [], adminRoleIds: [ROLE_ID] }).success
    ).toBe(true);
  });

  it('rejects malformed and repeated role ids', () => {
    const roles = (adminRoleIds: string[]) => ({ ...base, beforeAdminRoleIds: [], adminRoleIds });
    expect(AdminUserPermissionsChangeSchema.safeParse(roles(['nope'])).success).toBe(false);
    expect(AdminUserPermissionsChangeSchema.safeParse(roles([ROLE_ID, ROLE_ID.toUpperCase()])).success).toBe(false);
  });
});

describe('adminPermissionSources', () => {
  const support = {
    id: 'b'.repeat(24),
    name: 'Support agent',
    permissions: ['support:read', 'users:moderate'] as const,
  };
  const billing = { id: 'c'.repeat(24), name: 'Billing', permissions: ['support:read', 'credits:adjust'] as const };
  const roles = [
    { ...support, permissions: [...support.permissions] },
    { ...billing, permissions: [...billing.permissions] },
  ];

  it('lists each effective permission once with its direct grant and granting roles', () => {
    const sources = adminPermissionSources(['support:read', 'keys:revoke'], roles);
    expect(sources.map(source => [source.permission, formatAdminPermissionSource(source)])).toEqual([
      ['support:read', 'direct + role "Billing" + role "Support agent"'],
      ['credits:adjust', 'role "Billing"'],
      ['users:moderate', 'role "Support agent"'],
      ['keys:revoke', 'direct'],
    ]);
  });

  it.each([
    ['direct', 'role "direct"'],
    ['direct + Billing', 'role "direct + Billing"'],
    ['Support "ops"', String.raw`role "Support \"ops\""`],
  ])('identifies a role named %s without masquerading as a direct grant or multiple sources', (name, expected) => {
    expect(AdminRoleCreateSchema.safeParse({ name, permissions: ['support:read'] }).success).toBe(true);
    expect(formatAdminPermissionSource({ direct: false, roles: [{ id: ROLE_ID, name }] })).toBe(expected);
    expect(formatAdminPermissionSource({ direct: false, roles: [{ id: ROLE_ID, name }] })).not.toBe('direct');
  });

  it('distinguishes a direct grant combined with a role named direct', () => {
    expect(formatAdminPermissionSource({ direct: true, roles: [{ id: ROLE_ID, name: 'direct' }] })).toBe(
      'direct + role "direct"'
    );
  });

  it('matches the union hasAdminPermission applies to direct and role permissions', () => {
    const direct = ['keys:revoke', 'support:read'];
    const roleAdminPermissions = roles.flatMap(role => role.permissions);
    const effective = adminPermissionSources(direct, roles).map(source => source.permission);
    expect(effective).toEqual(sortAdminPermissions([...direct, ...roleAdminPermissions]));
    for (const permission of ADMIN_PERMISSIONS) {
      expect(effective.includes(permission)).toBe(
        hasAdminPermission({ adminPermissions: direct, roleAdminPermissions }, permission)
      );
    }
  });

  it('drops ids that are no longer admin permissions and handles no roles', () => {
    expect(adminPermissionSources(['retired:perm', 'support:read'], [])).toEqual([
      { permission: 'support:read', direct: true, roles: [] },
    ]);
    expect(adminPermissionSources([], [])).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSIONS,
  AdminUserPermissionsChangeSchema,
  assertCanActOnAdminTarget,
  canAccessAdmin,
  hasAdminPermission,
  meetsAdminPermissionRequirement,
} from './adminPermissions';
import { ADMIN_ROLE_TEMPLATES, AdminRoleCreateSchema, AdminRoleUpdateSchema } from './adminRoles';

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
    const templated = new Set(ADMIN_ROLE_TEMPLATES.flatMap(template => template.permissions));
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

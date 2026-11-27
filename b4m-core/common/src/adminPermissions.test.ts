import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSIONS,
  AdminPermissionsSchema,
  EXPLICIT_ONLY_ADMIN_PERMISSIONS,
  assertCanActOnAdminTarget,
  assertCanChangeExplicitOnlyPermissions,
  assertCanGrantAdminAccess,
  canAccessAdmin,
  hasAdminPermission,
  isFullAdmin,
  meetsAdminPermissionRequirement,
  missingAdminPermissionMessage,
} from './adminPermissions';
import { ForbiddenError } from './errors';

describe('admin permissions', () => {
  const IMPLIED_PERMISSIONS = ADMIN_PERMISSIONS.filter(
    permission => !(EXPLICIT_ONLY_ADMIN_PERMISSIONS as readonly string[]).includes(permission)
  );

  it.each(IMPLIED_PERMISSIONS)('preserves legacy full-admin access to %s', permission => {
    expect(hasAdminPermission({ isAdmin: true }, permission)).toBe(true);
  });

  it.each(EXPLICIT_ONLY_ADMIN_PERMISSIONS)('does not imply %s from the full-admin flag', permission => {
    expect(hasAdminPermission({ isAdmin: true }, permission)).toBe(false);
    expect(hasAdminPermission({ isAdmin: true, adminPermissions: [permission] }, permission)).toBe(true);
    expect(hasAdminPermission({ isAdmin: true, roleAdminPermissions: [permission] }, permission)).toBe(true);
  });

  it.each(EXPLICIT_ONLY_ADMIN_PERMISSIONS)('grants no admin access from %s alone', permission => {
    expect(canAccessAdmin({ adminPermissions: [permission] })).toBe(false);
  });

  it.each(ADMIN_PERMISSIONS)('grants only the explicit permission %s', permission => {
    const user = { isAdmin: false, adminPermissions: [permission] };
    for (const candidate of ADMIN_PERMISSIONS) {
      expect(hasAdminPermission(user, candidate)).toBe(candidate === permission);
    }
    expect(isFullAdmin(user)).toBe(false);
  });

  it.each(IMPLIED_PERMISSIONS)('opens the admin area with %s', permission => {
    expect(canAccessAdmin({ adminPermissions: [permission] })).toBe(true);
  });

  it.each([null, undefined, {}, { isAdmin: false }, { adminPermissions: [] }])(
    'fails closed for identities without permissions: %j',
    user => {
      expect(canAccessAdmin(user)).toBe(false);
      expect(isFullAdmin(user)).toBe(false);
      for (const permission of ADMIN_PERMISSIONS) expect(hasAdminPermission(user, permission)).toBe(false);
    }
  );

  it('treats only the legacy flag as full admin, not a complete explicit grant set', () => {
    expect(isFullAdmin({ isAdmin: true })).toBe(true);
    expect(isFullAdmin({ adminPermissions: [...ADMIN_PERMISSIONS] })).toBe(false);
    expect(canAccessAdmin({ adminPermissions: [...ADMIN_PERMISSIONS] })).toBe(true);
  });

  describe('assertCanActOnAdminTarget', () => {
    const delegated = { adminPermissions: [...ADMIN_PERMISSIONS] };

    it('refuses a delegated actor against a target with admin access', () => {
      expect(() => assertCanActOnAdminTarget(delegated, { adminPermissions: ['support:read'] }, 'delete')).toThrow(
        'Only full administrators can delete users with admin access'
      );
      expect(() => assertCanActOnAdminTarget(delegated, { isAdmin: true }, 'delete')).toThrow(ForbiddenError);
    });

    it('allows a full admin against a privileged target and anyone against a regular user', () => {
      expect(() => assertCanActOnAdminTarget({ isAdmin: true }, { isAdmin: true }, 'delete')).not.toThrow();
      expect(() => assertCanActOnAdminTarget(delegated, { isAdmin: false }, 'delete')).not.toThrow();
    });
  });

  describe('assertCanGrantAdminAccess', () => {
    const manager = { adminPermissions: ['settings:manage', 'support:read'] };

    it('lets a delegated manager grant only permissions it holds', () => {
      expect(() =>
        assertCanGrantAdminAccess(manager, { isAdmin: false, adminPermissions: ['support:read'] })
      ).not.toThrow();
      expect(() =>
        assertCanGrantAdminAccess(manager, { isAdmin: false, adminPermissions: ['support:read', 'users:delete'] })
      ).toThrow('Cannot grant permissions you do not hold: users:delete');
    });

    it('refuses the full-admin flag to anyone but a full admin', () => {
      expect(() => assertCanGrantAdminAccess({ adminPermissions: [...ADMIN_PERMISSIONS] }, { isAdmin: true })).toThrow(
        'Only full administrators can grant full admin access'
      );
      expect(() =>
        assertCanGrantAdminAccess({ isAdmin: true }, { isAdmin: true, adminPermissions: [...ADMIN_PERMISSIONS] })
      ).not.toThrow();
    });
  });

  it('builds the shared missing-permission message', () => {
    expect(missingAdminPermissionMessage('users:delete')).toBe('Missing permission: users:delete');
    expect(missingAdminPermissionMessage(['support:read', 'settings:manage'])).toBe(
      'Missing permission: support:read or settings:manage'
    );
  });

  it('meets an any-of requirement with any one listed permission', () => {
    const requirement = ['support:read', 'settings:manage'] as const;
    expect(meetsAdminPermissionRequirement({ adminPermissions: ['settings:manage'] }, requirement)).toBe(true);
    expect(meetsAdminPermissionRequirement({ adminPermissions: ['support:read'] }, requirement)).toBe(true);
    expect(meetsAdminPermissionRequirement({ adminPermissions: ['users:moderate'] }, requirement)).toBe(false);
    expect(meetsAdminPermissionRequirement({ isAdmin: true }, 'users:delete')).toBe(true);
    expect(meetsAdminPermissionRequirement({ isAdmin: true }, [])).toBe(false);
  });

  it('does not grant access from arbitrary persisted values', () => {
    expect(canAccessAdmin({ adminPermissions: ['admin', '*', 'SUPPORT:READ'] })).toBe(false);
  });

  it('rejects unknown permissions at the input boundary', () => {
    expect(AdminPermissionsSchema.safeParse(['support:read', 'users:write']).success).toBe(false);
    expect(AdminPermissionsSchema.parse([...ADMIN_PERMISSIONS])).toEqual(ADMIN_PERMISSIONS);
  });

  it('rejects repeated permissions at the input boundary', () => {
    expect(AdminPermissionsSchema.safeParse(['support:read', 'support:read']).success).toBe(false);
  });

  describe('assertCanChangeExplicitOnlyPermissions', () => {
    const FULL_ADMIN = { isAdmin: true };
    const HOLDER = { isAdmin: true, adminPermissions: ['credits:approve_self_grant'] };

    it('refuses a full admin without the permission adding it', () => {
      expect(() => assertCanChangeExplicitOnlyPermissions(FULL_ADMIN, [], ['credits:approve_self_grant'])).toThrow(
        ForbiddenError
      );
    });

    it('refuses a full admin without the permission removing it', () => {
      expect(() => assertCanChangeExplicitOnlyPermissions(FULL_ADMIN, ['credits:approve_self_grant'], [])).toThrow(
        ForbiddenError
      );
    });

    it('lets a holder add or remove it', () => {
      expect(() => assertCanChangeExplicitOnlyPermissions(HOLDER, [], ['credits:approve_self_grant'])).not.toThrow();
      expect(() => assertCanChangeExplicitOnlyPermissions(HOLDER, ['credits:approve_self_grant'], [])).not.toThrow();
    });

    it('counts a permission held through a role', () => {
      const viaRole = { isAdmin: true, roleAdminPermissions: ['credits:approve_self_grant'] };
      expect(() => assertCanChangeExplicitOnlyPermissions(viaRole, [], ['credits:approve_self_grant'])).not.toThrow();
    });

    it('passes unrelated changes and unchanged explicit-only permissions', () => {
      expect(() =>
        assertCanChangeExplicitOnlyPermissions(FULL_ADMIN, ['support:read'], ['credits:adjust'])
      ).not.toThrow();
      expect(() =>
        assertCanChangeExplicitOnlyPermissions(
          FULL_ADMIN,
          ['credits:self_grant'],
          ['credits:self_grant', 'support:read']
        )
      ).not.toThrow();
    });
  });
});

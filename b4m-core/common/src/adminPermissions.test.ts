import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSIONS,
  AdminPermissionsSchema,
  assertCanActOnAdminTarget,
  assertCanGrantAdminAccess,
  canAccessAdmin,
  hasAdminPermission,
  isFullAdmin,
  missingAdminPermissionMessage,
} from './adminPermissions';
import { ForbiddenError } from './errors';

describe('admin permissions', () => {
  it.each(ADMIN_PERMISSIONS)('preserves legacy full-admin access to %s', permission => {
    expect(hasAdminPermission({ isAdmin: true }, permission)).toBe(true);
  });

  it.each(ADMIN_PERMISSIONS)('grants only the explicit permission %s', permission => {
    const user = { isAdmin: false, adminPermissions: [permission] };
    for (const candidate of ADMIN_PERMISSIONS) {
      expect(hasAdminPermission(user, candidate)).toBe(candidate === permission);
    }
    expect(canAccessAdmin(user)).toBe(true);
    expect(isFullAdmin(user)).toBe(false);
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
});

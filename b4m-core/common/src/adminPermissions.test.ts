import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSIONS,
  AdminPermissionsSchema,
  canAccessAdmin,
  hasAdminPermission,
  isFullAdmin,
} from './adminPermissions';

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

  it('recognizes a fully delegated admin without the legacy flag', () => {
    expect(isFullAdmin({ adminPermissions: [...ADMIN_PERMISSIONS] })).toBe(true);
    expect(isFullAdmin({ adminPermissions: [...ADMIN_PERMISSIONS.slice(1)] })).toBe(false);
  });

  it('does not grant access from arbitrary persisted values', () => {
    expect(canAccessAdmin({ adminPermissions: ['admin', '*', 'SUPPORT:READ'] })).toBe(false);
  });

  it('rejects unknown permissions at the input boundary', () => {
    expect(AdminPermissionsSchema.safeParse(['support:read', 'users:write']).success).toBe(false);
    expect(AdminPermissionsSchema.parse([...ADMIN_PERMISSIONS])).toEqual(ADMIN_PERMISSIONS);
  });
});

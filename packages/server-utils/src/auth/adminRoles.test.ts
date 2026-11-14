import { describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { canAccessAdmin, hasAdminPermission, type AdminPermissionId } from '@bike4mind/common';

const mockFindByIds = vi.fn();
vi.mock('@bike4mind/database', () => ({ adminRoleRepository: { findByIds: (ids: string[]) => mockFindByIds(ids) } }));

import { resolveRoleAdminPermissions } from './adminRoles';
import { withholdAdminRole } from './apiKeyAdminScope';

// Mirrors the User schema's adminRoleIds field and roleAdminPermissions virtual (UserModel.ts).
const schema = new mongoose.Schema(
  {
    isAdmin: { type: Boolean, default: false },
    adminPermissions: { type: [String], default: [] },
    adminRoleIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  },
  { toJSON: { virtuals: true } }
);
schema.virtual('roleAdminPermissions').get(function () {
  return this.$locals.roleAdminPermissions;
});
const TestUser = mongoose.model('AdminRolesResolveTestUser', schema);

const SUPPORT = 'a'.repeat(24);
const BILLING = 'b'.repeat(24);
const DELETED = 'c'.repeat(24);

/** Reads the field as a request handler would: the virtual, or withholdAdminRole's own accessor. */
const roleAdminPermissionsOf = (user: object) => (user as { roleAdminPermissions?: unknown }).roleAdminPermissions;

const userWith = (fields: Record<string, unknown>) =>
  TestUser.hydrate({ _id: new mongoose.Types.ObjectId(), adminPermissions: [], adminRoleIds: [], ...fields });

const rolesById: Record<string, { permissions: AdminPermissionId[] }> = {
  [SUPPORT]: { permissions: ['support:read', 'users:moderate'] },
  [BILLING]: { permissions: ['support:read', 'credits:adjust'] },
};
const find = vi.fn(async (ids: readonly string[]) => ids.flatMap(id => (rolesById[id] ? [rolesById[id]] : [])));

describe('resolveRoleAdminPermissions', () => {
  it('unions every role with the direct grants, in ADMIN_PERMISSIONS order', async () => {
    const user = userWith({ adminPermissions: ['keys:revoke'], adminRoleIds: [BILLING, SUPPORT] });

    await resolveRoleAdminPermissions(user, find);

    expect(user.get('roleAdminPermissions')).toEqual(['support:read', 'credits:adjust', 'users:moderate']);
    for (const permission of ['support:read', 'credits:adjust', 'users:moderate', 'keys:revoke'] as const) {
      expect(hasAdminPermission(user.toJSON(), permission)).toBe(true);
    }
    expect(hasAdminPermission(user.toJSON(), 'users:delete')).toBe(false);
  });

  it('never persists role permissions as direct grants', async () => {
    const user = userWith({ adminRoleIds: [SUPPORT] });

    await resolveRoleAdminPermissions(user, find);

    expect(user.isModified()).toBe(false);
    expect(user.get('adminPermissions')).toEqual([]);
    expect(user.toObject({ virtuals: false })).not.toHaveProperty('roleAdminPermissions');
    expect(roleAdminPermissionsOf(user.toJSON())).toEqual(['support:read', 'users:moderate']);
  });

  it('grants nothing for unknown or deleted roles', async () => {
    const user = userWith({ adminRoleIds: [DELETED] });

    await resolveRoleAdminPermissions(user, find);

    expect(user.get('roleAdminPermissions')).toEqual([]);
    expect(hasAdminPermission(user.toJSON(), 'support:read')).toBe(false);
  });

  it('costs no query for a user without roles', async () => {
    find.mockClear();
    const user = userWith({ adminPermissions: ['support:read'] });

    await resolveRoleAdminPermissions(user, find);

    expect(find).not.toHaveBeenCalled();
    expect(user.get('roleAdminPermissions')).toEqual([]);
  });

  it('resolves a plain object as well', async () => {
    const user: { adminRoleIds: string[]; roleAdminPermissions?: string[] } = { adminRoleIds: [SUPPORT] };

    await resolveRoleAdminPermissions(user, find);

    expect(roleAdminPermissionsOf(user)).toEqual(['support:read', 'users:moderate']);
  });

  it('reads the role repository by default', async () => {
    mockFindByIds.mockResolvedValueOnce([{ permissions: ['settings:manage'] }]);
    const user = userWith({ adminRoleIds: [SUPPORT] });

    await resolveRoleAdminPermissions(user);

    expect(mockFindByIds).toHaveBeenCalledWith([SUPPORT]);
    expect(user.get('roleAdminPermissions')).toEqual(['settings:manage']);
  });
});

describe('role permissions behind an API key without the admin scope', () => {
  it('withholds a role-only admin resolved first', async () => {
    const user = userWith({ adminRoleIds: [SUPPORT] });
    await resolveRoleAdminPermissions(user, find);

    withholdAdminRole(user);

    expect(roleAdminPermissionsOf(user)).toEqual([]);
    expect(hasAdminPermission(user, 'support:read')).toBe(false);
    expect(canAccessAdmin(user)).toBe(false);
    expect(user.isModified()).toBe(false);
  });

  it('keeps them withheld when roles are resolved after the withhold', async () => {
    const user = userWith({ adminRoleIds: [SUPPORT] });
    withholdAdminRole(user);

    await resolveRoleAdminPermissions(user, find);

    expect(hasAdminPermission(user, 'support:read')).toBe(false);
    expect(canAccessAdmin(user)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { Permission } from '@bike4mind/common';

/**
 * Tests the organization permission logic from /routes/organizations/$id.tsx.
 */
describe('Organization Permissions', () => {
  // Helper function to simulate the permission checking logic
  const getUserPermissions = (
    currentUser: { id: string; isAdmin?: boolean } | null,
    organization: { userId: string; users: Array<{ userId: string; permissions: Permission[] }> } | null
  ): Permission[] => {
    if (!currentUser || !organization) return [];
    if (currentUser.isAdmin) return [Permission.read, Permission.update, Permission.share];
    if (currentUser.id === organization.userId) return [Permission.read, Permission.update, Permission.share];
    const memberDetails = organization.users.find(u => u.userId === currentUser.id);
    return memberDetails?.permissions || []; // No permissions for non-members
  };

  const mockOrganization = {
    userId: 'owner123',
    users: [
      { userId: 'owner123', permissions: [Permission.read, Permission.update, Permission.share] },
      { userId: 'member456', permissions: [Permission.read, Permission.update] },
      { userId: 'viewer789', permissions: [Permission.read] },
    ],
  };

  describe('Owner Permissions', () => {
    it('should grant full permissions to organization owner', () => {
      const currentUser = { id: 'owner123' };
      const permissions = getUserPermissions(currentUser, mockOrganization);

      expect(permissions).toEqual([Permission.read, Permission.update, Permission.share]);
    });

    it('should grant full permissions to owner even if not in users array', () => {
      const orgWithoutOwnerInUsers = {
        userId: 'owner999',
        users: [{ userId: 'member456', permissions: [Permission.read] }],
      };
      const currentUser = { id: 'owner999' };
      const permissions = getUserPermissions(currentUser, orgWithoutOwnerInUsers);

      expect(permissions).toEqual([Permission.read, Permission.update, Permission.share]);
    });
  });

  describe('Admin Permissions', () => {
    it('should grant full permissions to system admin', () => {
      const currentUser = { id: 'admin123', isAdmin: true };
      const permissions = getUserPermissions(currentUser, mockOrganization);

      expect(permissions).toEqual([Permission.read, Permission.update, Permission.share]);
    });

    it('should grant member-level permissions to regular member (not admin)', () => {
      const currentUser = { id: 'member456' }; // Regular member without admin
      const permissions = getUserPermissions(currentUser, mockOrganization);

      expect(permissions).toEqual([Permission.read, Permission.update]); // Member permissions
    });
  });

  describe('Member Permissions', () => {
    it('should grant member-level permissions from organization.users', () => {
      const currentUser = { id: 'member456' };
      const permissions = getUserPermissions(currentUser, mockOrganization);

      expect(permissions).toEqual([Permission.read, Permission.update]);
    });

    it('should grant read-only permissions to viewer', () => {
      const currentUser = { id: 'viewer789' };
      const permissions = getUserPermissions(currentUser, mockOrganization);

      expect(permissions).toEqual([Permission.read]);
    });

    it('should grant no permissions to non-member (security fix)', () => {
      const currentUser = { id: 'stranger999' };
      const permissions = getUserPermissions(currentUser, mockOrganization);

      expect(permissions).toEqual([]); // No permissions for non-members
    });
  });

  describe('Edge Cases', () => {
    it('should return empty array when currentUser is null', () => {
      const permissions = getUserPermissions(null, mockOrganization);

      expect(permissions).toEqual([]);
    });

    it('should return empty array when organization is null', () => {
      const currentUser = { id: 'user123' };
      const permissions = getUserPermissions(currentUser, null);

      expect(permissions).toEqual([]);
    });
  });

  describe('canManageOrg Helper', () => {
    const canManageOrg = (permissions: Permission[]): boolean => {
      return permissions.includes(Permission.share) || permissions.includes(Permission.update);
    };

    it('should allow management with share permission', () => {
      const permissions = [Permission.read, Permission.share];
      expect(canManageOrg(permissions)).toBe(true);
    });

    it('should allow management with update permission', () => {
      const permissions = [Permission.read, Permission.update];
      expect(canManageOrg(permissions)).toBe(true);
    });

    it('should not allow management with only read permission', () => {
      const permissions = [Permission.read];
      expect(canManageOrg(permissions)).toBe(false);
    });

    it('should allow management with full permissions', () => {
      const permissions = [Permission.read, Permission.update, Permission.share];
      expect(canManageOrg(permissions)).toBe(true);
    });
  });

  describe('canViewUsage Helper', () => {
    // Mirrors the canViewUsage memo in $id.tsx, which intentionally does NOT use
    // the permission set: it must match the server gate (verifyOrgAccess) exactly
    // - admin, org owner, or team manager - so the Usage tab never shows to
    // someone the API would 404. Kept in sync with orgAccess.ts::verifyOrgAccess.
    const canViewUsage = (
      currentUser: { id: string; isAdmin?: boolean } | null,
      organization: { userId: string; managerId?: string | null } | null
    ): boolean => {
      if (!currentUser || !organization) return false;
      if (currentUser.isAdmin) return true;
      if (currentUser.id === organization.userId) return true;
      return organization.managerId === currentUser.id;
    };

    const org = { userId: 'owner123', managerId: 'manager456' };

    it('allows the org owner', () => {
      expect(canViewUsage({ id: 'owner123' }, org)).toBe(true);
    });

    it('allows the team manager', () => {
      expect(canViewUsage({ id: 'manager456' }, org)).toBe(true);
    });

    it('allows a platform admin who is neither owner nor manager', () => {
      expect(canViewUsage({ id: 'someoneelse', isAdmin: true }, org)).toBe(true);
    });

    it('denies a stranger', () => {
      expect(canViewUsage({ id: 'stranger999' }, org)).toBe(false);
    });

    it('denies a plain member with manage permissions but no owner/manager role', () => {
      // A member can hold share/update (canManageOrg true) yet not be owner/manager;
      // verifyOrgAccess would 404 them, so the Usage tab must stay hidden.
      expect(canViewUsage({ id: 'member456' }, { userId: 'owner123', managerId: null })).toBe(false);
    });

    it('returns false when user or organization is missing', () => {
      expect(canViewUsage(null, org)).toBe(false);
      expect(canViewUsage({ id: 'owner123' }, null)).toBe(false);
    });
  });
});

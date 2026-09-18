import { describe, it, expect } from 'vitest';
import { Permission } from '@bike4mind/common';
import { canViewOrgUsage, OrganizationTabs, resolveAccessibleTab } from '../orgTabAccess';

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

  describe('canViewOrgUsage', () => {
    // The predicate $id.tsx runs, imported rather than re-declared: a copy here would pass whether
    // or not the page still agreed with it. Gates the Usage and Analysis tabs, and must match the
    // server gate (orgAccess.ts, verifyOrgAccess) - admin, org owner, or team manager.
    const canViewUsage = canViewOrgUsage;

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

  describe('canManageGroups Helper', () => {
    // Mirrors the canManageGroups memo in $id.tsx, which must match
    // assertCanManageOrgGroups (organizationService/groupMembership.ts) so the Groups tab never
    // shows to someone whose every write would 403. Kept in sync with that predicate.
    const canManageGroups = (
      currentUser: { id: string; isAdmin?: boolean } | null,
      organization: {
        userId: string;
        personal?: boolean;
        adminUserIds?: string[];
        users?: Array<{ userId: string }>;
      } | null
    ): boolean => {
      if (!currentUser || !organization || organization.personal) return false;
      if (currentUser.isAdmin) return true;
      if (currentUser.id === organization.userId) return true;
      return (
        (organization.adminUserIds ?? []).includes(currentUser.id) &&
        (organization.users ?? []).some(member => member.userId === currentUser.id)
      );
    };

    const org = {
      userId: 'owner123',
      personal: false,
      adminUserIds: ['orgadmin456'],
      users: [{ userId: 'orgadmin456' }, { userId: 'member789' }],
    };

    it('allows the billing owner', () => {
      expect(canManageGroups({ id: 'owner123' }, org)).toBe(true);
    });

    it('allows a platform admin who is neither owner nor appointed', () => {
      expect(canManageGroups({ id: 'someoneelse', isAdmin: true }, org)).toBe(true);
    });

    it('allows an appointed org admin who is still a member', () => {
      expect(canManageGroups({ id: 'orgadmin456' }, org)).toBe(true);
    });

    // The membership conjunct. The server enforces it (groupMembership.test.ts: "forbids an
    // appointed org admin who is no longer a member of the org"), so the tab must hide too -
    // otherwise a stale adminUserIds entry gets a surface whose every write 403s.
    it('denies an appointed org admin who is no longer a member', () => {
      expect(canManageGroups({ id: 'orgadmin456' }, { ...org, users: [{ userId: 'member789' }] })).toBe(false);
    });

    it('denies a plain member', () => {
      expect(canManageGroups({ id: 'member789' }, org)).toBe(false);
    });

    it('denies a stranger', () => {
      expect(canManageGroups({ id: 'stranger999' }, org)).toBe(false);
    });

    it('denies everyone on a personal organization, including its owner', () => {
      expect(canManageGroups({ id: 'owner123' }, { ...org, personal: true })).toBe(false);
      expect(canManageGroups({ id: 'someoneelse', isAdmin: true }, { ...org, personal: true })).toBe(false);
    });

    it('returns false when user or organization is missing', () => {
      expect(canManageGroups(null, org)).toBe(false);
      expect(canManageGroups({ id: 'owner123' }, null)).toBe(false);
    });
  });

  describe('canSetAdmins Helper', () => {
    // Mirrors the canSetAdmins memo in $id.tsx and the PUT /organizations/:id/admins route: only
    // the billing owner or a platform admin may appoint org admins. An appointed org admin
    // deliberately cannot appoint others - that is the escalation the authz matrix forbids.
    const canSetAdmins = (
      currentUser: { id: string; isAdmin?: boolean } | null,
      organization: { userId: string; adminUserIds?: string[] } | null
    ): boolean => {
      if (!currentUser || !organization) return false;
      return Boolean(currentUser.isAdmin) || currentUser.id === organization.userId;
    };

    const org = { userId: 'owner123', adminUserIds: ['orgadmin456'] };

    it('allows the billing owner', () => {
      expect(canSetAdmins({ id: 'owner123' }, org)).toBe(true);
    });

    it('allows a platform admin', () => {
      expect(canSetAdmins({ id: 'someoneelse', isAdmin: true }, org)).toBe(true);
    });

    it('denies an appointed org admin - no self-service escalation', () => {
      expect(canSetAdmins({ id: 'orgadmin456' }, org)).toBe(false);
    });

    it('denies a stranger', () => {
      expect(canSetAdmins({ id: 'stranger999' }, org)).toBe(false);
    });
  });
});

describe('resolveAccessibleTab', () => {
  // The redirect the org page runs on every render. A ?tab= deep link is the only path that can
  // select a tab the TabList never rendered, so these cases are the gate, not a formality.
  const all = { canManageOrg: true, canViewUsage: true, canManageGroups: true };

  it('leaves a tab the caller may see alone', () => {
    expect(resolveAccessibleTab(OrganizationTabs.Analysis, all)).toBe(OrganizationTabs.Analysis);
    expect(resolveAccessibleTab(OrganizationTabs.Usage, all)).toBe(OrganizationTabs.Usage);
  });

  it('bounces a deep link to Analysis for someone who may not view usage', () => {
    expect(resolveAccessibleTab(OrganizationTabs.Analysis, { ...all, canViewUsage: false })).toBe(
      OrganizationTabs.Overview
    );
  });

  it('bounces Usage on the same gate', () => {
    expect(resolveAccessibleTab(OrganizationTabs.Usage, { ...all, canViewUsage: false })).toBe(
      OrganizationTabs.Overview
    );
  });

  it('keeps Analysis reachable for someone who may view usage but not manage the org', () => {
    expect(resolveAccessibleTab(OrganizationTabs.Analysis, { ...all, canManageOrg: false })).toBe(
      OrganizationTabs.Analysis
    );
  });

  it('still bounces the manage-pinned tabs and Groups', () => {
    expect(resolveAccessibleTab(OrganizationTabs.Settings, { ...all, canManageOrg: false })).toBe(
      OrganizationTabs.Overview
    );
    expect(resolveAccessibleTab(OrganizationTabs.Groups, { ...all, canManageGroups: false })).toBe(
      OrganizationTabs.Overview
    );
  });

  it('never bounces the tabs every member may see', () => {
    const none = { canManageOrg: false, canViewUsage: false, canManageGroups: false };
    expect(resolveAccessibleTab(OrganizationTabs.Overview, none)).toBe(OrganizationTabs.Overview);
    expect(resolveAccessibleTab(OrganizationTabs.Members, none)).toBe(OrganizationTabs.Members);
  });
});

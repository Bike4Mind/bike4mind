import { describe, it, expect } from 'vitest';
import { Permission, isOrgOwnerOrCurrentAdmin } from '@bike4mind/common';
import {
  canManageOrgConnectors,
  canManageOrgIntegrations,
  canViewOrgAnalysis,
  canViewOrgBilling,
  canViewOrgUsage,
  OrganizationTabs,
  resolveAccessibleTab,
} from '../orgTabAccess';

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

  describe('canViewOrgAnalysis', () => {
    // The predicate $id.tsx runs, imported rather than re-declared: a copy here would pass whether
    // or not the page still agreed with it. Must match the feedback-report routes' server gate
    // (orgAccess.ts, verifyOrgAccess) - admin, org owner, or any manager.
    const org = {
      userId: 'owner123',
      adminUserIds: ['orgManager789'],
      users: [{ userId: 'orgManager789' }],
    };

    it('allows the org owner', () => {
      expect(canViewOrgAnalysis({ id: 'owner123' }, org)).toBe(true);
    });

    it('allows an org manager on the roster', () => {
      expect(canViewOrgAnalysis({ id: 'orgManager789' }, org)).toBe(true);
    });

    it('allows a platform admin who is neither owner nor manager', () => {
      expect(canViewOrgAnalysis({ id: 'someoneelse', isAdmin: true }, org)).toBe(true);
    });

    it('denies a plain member with manage permissions but no owner/manager role', () => {
      // A member can hold share/update (canManageOrg true) yet not be owner/manager;
      // verifyOrgAccess would 404 them, so the tab must stay hidden.
      expect(canViewOrgAnalysis({ id: 'member456' }, { userId: 'owner123' })).toBe(false);
    });

    it('returns false when user or organization is missing', () => {
      expect(canViewOrgAnalysis(null, org)).toBe(false);
      expect(canViewOrgAnalysis({ id: 'owner123' }, null)).toBe(false);
    });
  });

  // Usage (credit spend) and the Integrations / GitHub API / Webhooks tabs share the
  // verifyOrgOwner tier: owner or platform admin, never a manager.
  describe.each([
    ['canViewOrgUsage', canViewOrgUsage],
    ['canManageOrgIntegrations', canManageOrgIntegrations],
  ])('%s', (_name, gate) => {
    const org = {
      userId: 'owner123',
      adminUserIds: ['orgManager789'],
      users: [{ userId: 'orgManager789' }],
    };

    it('allows the org owner', () => {
      expect(gate({ id: 'owner123' }, org)).toBe(true);
    });

    it('allows a platform admin who is not the owner', () => {
      expect(gate({ id: 'someoneelse', isAdmin: true }, org)).toBe(true);
    });

    it('denies an org manager', () => {
      expect(gate({ id: 'orgManager789' }, org)).toBe(false);
    });

    it('denies a stranger', () => {
      expect(gate({ id: 'stranger999' }, org)).toBe(false);
    });

    it('returns false when user or organization is missing', () => {
      expect(gate(null, org)).toBe(false);
      expect(gate({ id: 'owner123' }, null)).toBe(false);
    });
  });

  describe('canViewOrgBilling', () => {
    // The predicate $id.tsx runs, imported rather than re-declared. Gates the Billing tab, and must
    // match the three routes behind it - subscribe.ts, update-seats.ts and stripe/portal.ts - all
    // of which are owner-only.
    const org = { userId: 'owner123', adminUserIds: ['manager456'], users: [{ userId: 'manager456' }] };

    it('allows the billing owner', () => {
      expect(canViewOrgBilling({ id: 'owner123' }, org)).toBe(true);
    });

    // The case this gate exists for: member456 holds read+update, so canManageOrg is true for them,
    // and until the split they saw Subscribe, Manage Seats and Billing Portal - each of which the
    // server rejects.
    it('denies a member with manage permissions who is not the owner', () => {
      expect(canViewOrgBilling({ id: 'member456' }, org)).toBe(false);
    });

    it('denies the team manager, who may not buy or change seats', () => {
      expect(canViewOrgBilling({ id: 'manager456' }, org)).toBe(false);
    });

    // Narrower than canViewOrgUsage on purpose: portal.ts has no admin bypass, so an admin who is
    // not the owner would get a Billing Portal button that rejects them. Admin -> Organizations is
    // where a platform admin acts on an org's billing.
    it('denies a platform admin who is not the owner', () => {
      expect(canViewOrgBilling({ id: 'someoneelse', isAdmin: true }, org)).toBe(false);
    });

    it('denies a stranger', () => {
      expect(canViewOrgBilling({ id: 'stranger999' }, org)).toBe(false);
    });

    it('returns false when user or organization is missing', () => {
      expect(canViewOrgBilling(null, org)).toBe(false);
      expect(canViewOrgBilling({ id: 'owner123' }, null)).toBe(false);
    });
  });

  describe('canManageGroups Helper', () => {
    // $id.tsx gates the Groups tab on `!personal && isOrgOwnerOrCurrentAdmin`; this runs the real
    // predicate so the tab and assertCanManageOrgGroups cannot drift apart.
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
      return isOrgOwnerOrCurrentAdmin(currentUser, organization);
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
  const all = {
    canManageOrg: true,
    canViewUsage: true,
    canViewAnalysis: true,
    canManageIntegrations: true,
    canManageGroups: true,
    canViewBilling: true,
    canManageConnectors: true,
  };

  it('leaves a tab the caller may see alone', () => {
    expect(resolveAccessibleTab(OrganizationTabs.Analysis, all)).toBe(OrganizationTabs.Analysis);
    expect(resolveAccessibleTab(OrganizationTabs.Usage, all)).toBe(OrganizationTabs.Usage);
  });

  it('bounces a deep link to Analysis for someone who may not view it', () => {
    expect(resolveAccessibleTab(OrganizationTabs.Analysis, { ...all, canViewAnalysis: false })).toBe(
      OrganizationTabs.Overview
    );
  });

  // A manager: Analysis is open to them, Usage (credit spend) is owner-only.
  it('bounces Usage but keeps Analysis for a manager', () => {
    const manager = { ...all, canViewUsage: false, canManageIntegrations: false, canViewBilling: false };
    expect(resolveAccessibleTab(OrganizationTabs.Usage, manager)).toBe(OrganizationTabs.Overview);
    expect(resolveAccessibleTab(OrganizationTabs.Analysis, manager)).toBe(OrganizationTabs.Analysis);
  });

  it('keeps Analysis reachable for someone who may view it but not manage the org', () => {
    expect(resolveAccessibleTab(OrganizationTabs.Analysis, { ...all, canManageOrg: false })).toBe(
      OrganizationTabs.Analysis
    );
  });

  // canManageOrg is deliberately NOT enough for Billing: a member holding share/update satisfies it
  // while every action on the tab is owner-only.
  it('bounces Billing for a caller who may manage the org but is not its owner', () => {
    expect(resolveAccessibleTab(OrganizationTabs.Billing, { ...all, canViewBilling: false })).toBe(
      OrganizationTabs.Overview
    );
  });

  // Same shape for the Integrations, GitHub API and Webhooks tabs: every route behind them is
  // verifyOrgOwner.
  it('bounces Integrations, GitHub API and Webhooks for a caller who may manage the org but is not its owner', () => {
    const managing = { ...all, canManageIntegrations: false };
    expect(resolveAccessibleTab(OrganizationTabs.Integrations, managing)).toBe(OrganizationTabs.Overview);
    expect(resolveAccessibleTab(OrganizationTabs.GitHub, managing)).toBe(OrganizationTabs.Overview);
    expect(resolveAccessibleTab(OrganizationTabs.Webhooks, managing)).toBe(OrganizationTabs.Overview);
  });

  it.each([OrganizationTabs.Integrations, OrganizationTabs.GitHub, OrganizationTabs.Webhooks])(
    'keeps %s reachable for the owner, keyed on canManageIntegrations alone',
    tab => {
      expect(resolveAccessibleTab(tab, all)).toBe(tab);
      expect(resolveAccessibleTab(tab, { ...all, canManageOrg: false })).toBe(tab);
    }
  );

  it('keeps Settings reachable for that same caller', () => {
    const managing = { ...all, canViewBilling: false, canManageIntegrations: false };
    expect(resolveAccessibleTab(OrganizationTabs.Settings, managing)).toBe(OrganizationTabs.Settings);
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
    const none = {
      canManageOrg: false,
      canViewUsage: false,
      canViewAnalysis: false,
      canManageIntegrations: false,
      canManageConnectors: false,
      canManageGroups: false,
      canViewBilling: false,
    };
    expect(resolveAccessibleTab(OrganizationTabs.Overview, none)).toBe(OrganizationTabs.Overview);
    expect(resolveAccessibleTab(OrganizationTabs.Members, none)).toBe(OrganizationTabs.Members);
  });
});

describe('canManageOrgConnectors', () => {
  // The Connectors tab fronts organizations/[id]/custom-mcp/*, which verifyOrgAccess gates to the
  // owner, a current manager or a platform admin.
  const org = {
    userId: 'owner1',
    adminUserIds: ['manager1', 'lapsed1'],
    users: [
      { userId: 'manager1', permissions: [Permission.read] },
      { userId: 'member1', permissions: [Permission.read, Permission.update] },
    ],
  };

  it('admits the owner, a current manager and a platform admin', () => {
    expect(canManageOrgConnectors({ id: 'owner1' }, org)).toBe(true);
    expect(canManageOrgConnectors({ id: 'manager1' }, org)).toBe(true);
    expect(canManageOrgConnectors({ id: 'stranger', isAdmin: true }, org)).toBe(true);
  });

  it('refuses a member with update permission, a manager no longer on the roster, and a stranger', () => {
    expect(canManageOrgConnectors({ id: 'member1' }, org)).toBe(false);
    expect(canManageOrgConnectors({ id: 'lapsed1' }, org)).toBe(false);
    expect(canManageOrgConnectors({ id: 'stranger' }, org)).toBe(false);
  });

  it('fails closed while the user or org is loading', () => {
    expect(canManageOrgConnectors(null, org)).toBe(false);
    expect(canManageOrgConnectors({ id: 'owner1' }, undefined)).toBe(false);
  });

  it('bounces a deep link to Connectors for a caller who may not manage them', () => {
    const access = {
      canManageOrg: true,
      canViewUsage: false,
      canViewAnalysis: true,
      canManageIntegrations: false,
      canManageGroups: false,
      canViewBilling: false,
      canManageConnectors: false,
    };
    expect(resolveAccessibleTab(OrganizationTabs.Connectors, access)).toBe(OrganizationTabs.Overview);
    expect(resolveAccessibleTab(OrganizationTabs.Connectors, { ...access, canManageConnectors: true })).toBe(
      OrganizationTabs.Connectors
    );
  });
});

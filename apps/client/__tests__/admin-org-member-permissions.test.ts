import { describe, it, expect } from 'vitest';
import { Permission } from '@bike4mind/common';

/**
 * Tests for org member permission logic across two surfaces:
 *
 *  1. Admin panel (OrganizationsTab.tsx)
 *     Any user with isAdmin: true gets [read, update, share] for ANY org.
 *     Logic: currentUser.isAdmin ? fullPerms : readOnly
 *
 *  2. b4m client org page ($id.tsx + UserCard.tsx)
 *     Only the org OWNER gets [read, update, share].
 *     Admins who are just members are treated as regular members (no update/share).
 *     The canRevoke / canCancelInvite actions in UserCard derive from userPermissions
 *     passed by the parent, so the same component enforces the correct rule in
 *     both the admin panel and the client view.
 */

// --- helpers mirroring component logic ---

/** OrganizationsTab.tsx - admin panel */
function adminPanelPermissions(isAdmin: boolean): Permission[] {
  return isAdmin ? [Permission.read, Permission.update, Permission.share] : [Permission.read];
}

/** $id.tsx - b4m client org page */
function clientOrgPermissions(
  currentUserId: string,
  org: { userId: string; users: { userId: string; permissions: Permission[] }[] }
): Permission[] {
  if (currentUserId === org.userId) return [Permission.read, Permission.update, Permission.share];
  const memberDetails = org.users.find(u => u.userId === currentUserId);
  return memberDetails?.permissions || [];
}

/** OrganizationMembers / UserCard - shared */
function canManageMembers(userPermissions: Permission[]): boolean {
  return userPermissions.includes(Permission.share) || userPermissions.includes(Permission.update);
}

// --- fixtures ---

const OWNER_ID = 'owner-001';
const ADMIN_MEMBER_ID = 'admin-member-002'; // isAdmin: true but only a member, not owner
const REGULAR_MEMBER_ID = 'member-003';

const org = {
  userId: OWNER_ID,
  users: [
    { userId: ADMIN_MEMBER_ID, permissions: [Permission.read] },
    { userId: REGULAR_MEMBER_ID, permissions: [Permission.read] },
  ],
};

// --- admin panel tests ---

describe('Admin panel — adminPanelPermissions', () => {
  it('grants update+share to any admin regardless of org relationship', () => {
    expect(canManageMembers(adminPanelPermissions(true))).toBe(true);
  });

  it('grants update+share to admin who is not a member of the org', () => {
    const perms = adminPanelPermissions(true);
    expect(perms).toContain(Permission.update);
    expect(perms).toContain(Permission.share);
  });

  it('restricts to read-only for non-admin in admin panel', () => {
    expect(canManageMembers(adminPanelPermissions(false))).toBe(false);
  });
});

// --- b4m client org page tests ---

describe('b4m client — clientOrgPermissions', () => {
  it('grants update+share to the org owner', () => {
    const perms = clientOrgPermissions(OWNER_ID, org);
    expect(canManageMembers(perms)).toBe(true);
  });

  it('does NOT grant update+share to an admin who is just a member', () => {
    const perms = clientOrgPermissions(ADMIN_MEMBER_ID, org);
    expect(canManageMembers(perms)).toBe(false);
  });

  it('does NOT grant update+share to a regular member', () => {
    const perms = clientOrgPermissions(REGULAR_MEMBER_ID, org);
    expect(canManageMembers(perms)).toBe(false);
  });

  it('returns empty permissions for a user with no org relationship', () => {
    const perms = clientOrgPermissions('stranger-999', org);
    expect(perms).toEqual([]);
    expect(canManageMembers(perms)).toBe(false);
  });
});

// --- UserCard canManageMembers (shared by both surfaces) ---

describe('UserCard — canManageMembers from userPermissions', () => {
  it('returns true when permissions include share', () => {
    expect(canManageMembers([Permission.read, Permission.update, Permission.share])).toBe(true);
  });

  it('returns true when permissions include update only', () => {
    expect(canManageMembers([Permission.read, Permission.update])).toBe(true);
  });

  it('returns false for read-only permissions', () => {
    expect(canManageMembers([Permission.read])).toBe(false);
  });

  it('returns false for empty permissions', () => {
    expect(canManageMembers([])).toBe(false);
  });
});

// --- end-to-end surface comparison ---

describe('end-to-end: admin panel vs b4m client', () => {
  it('admin can add/remove in admin panel even for orgs they do not own', () => {
    expect(canManageMembers(adminPanelPermissions(true))).toBe(true);
  });

  it('org owner can add/remove in b4m client', () => {
    expect(canManageMembers(clientOrgPermissions(OWNER_ID, org))).toBe(true);
  });

  it('admin-as-member CANNOT add/remove in b4m client', () => {
    expect(canManageMembers(clientOrgPermissions(ADMIN_MEMBER_ID, org))).toBe(false);
  });

  it('regular member CANNOT add/remove in b4m client', () => {
    expect(canManageMembers(clientOrgPermissions(REGULAR_MEMBER_ID, org))).toBe(false);
  });
});

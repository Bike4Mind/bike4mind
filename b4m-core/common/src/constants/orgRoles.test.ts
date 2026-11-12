import { describe, expect, it } from 'vitest';
import {
  ORG_PERMISSIONS,
  ORG_ROLE_PERMISSIONS,
  hasOrgPermission,
  orgMemberHasPermission,
  organizationMemberRole,
  type OrgPermission,
  type OrgRoleSubject,
} from './orgRoles';

const org: OrgRoleSubject = {
  userId: 'owner',
  adminUserIds: ['manager', 'stale-manager'],
  billingManagerUserIds: ['billing'],
  users: [{ userId: 'manager' }, { userId: 'billing' }, { userId: 'member' }],
};

type Actor = { id: string; isAdmin?: boolean };

const actors: Record<string, Actor> = {
  owner: { id: 'owner' },
  manager: { id: 'manager' },
  staleManager: { id: 'stale-manager' },
  billingManager: { id: 'billing' },
  member: { id: 'member' },
  outsider: { id: 'outsider' },
  platformAdmin: { id: 'outsider', isAdmin: true },
};

/**
 * The two gates every org-admin route used before roles existed, copied verbatim so this file pins
 * that the role table reproduces them: `verifyOrgOwner` / `isOrgOwnerOrPlatformAdmin`, and
 * `verifyOrgAccess` / `isOrgOwnerOrCurrentAdmin`.
 */
const legacyOwnerTier = (actor: Actor) => actor.isAdmin === true || org.userId === actor.id;
const legacyManagerTier = (actor: Actor) =>
  legacyOwnerTier(actor) ||
  ((org.adminUserIds ?? []).includes(actor.id) && (org.users ?? []).some(member => member.userId === actor.id));

/** Which pre-roles tier gated each permission's routes. */
const LEGACY_TIER: Record<OrgPermission, (actor: Actor) => boolean> = {
  manageMembers: legacyManagerTier,
  managePolicies: legacyManagerTier,
  manageKeys: legacyManagerTier,
  manageContent: legacyManagerTier,
  // The audit routes call orgMemberHasPermission (no admin arm); hasOrgPermission adds one uniformly.
  viewAudit: legacyManagerTier,
  manageBilling: legacyOwnerTier,
  viewUsage: legacyOwnerTier,
  manageIntegrations: legacyOwnerTier,
};

describe('organizationMemberRole', () => {
  it.each([
    ['owner', 'owner'],
    ['manager', 'manager'],
    ['billing', 'billingManager'],
    ['member', 'member'],
    ['stale-manager', null],
    ['outsider', null],
  ])('%s -> %s', (userId, role) => {
    expect(organizationMemberRole(org, userId)).toBe(role);
  });

  it('resolves the owner first even when listed in a role list', () => {
    expect(organizationMemberRole({ ...org, adminUserIds: ['owner'], users: [] }, 'owner')).toBe('owner');
  });

  it('resolves Manager before Billing manager if the lists ever overlap', () => {
    expect(organizationMemberRole({ ...org, billingManagerUserIds: ['manager'] }, 'manager')).toBe('manager');
  });
});

describe('hasOrgPermission', () => {
  // The before/after matrix: for every role that existed before (owner, manager, member, platform
  // admin, outsider), each permission answers exactly what its route's old gate answered.
  const existingRoles = ['owner', 'manager', 'staleManager', 'member', 'outsider', 'platformAdmin'] as const;
  const matrix = existingRoles.flatMap(name => ORG_PERMISSIONS.map(permission => [name, permission] as const));

  it.each(matrix)('%s / %s matches the pre-roles gate', (name, permission) => {
    const actor = actors[name];
    expect(hasOrgPermission(actor, org, permission)).toBe(LEGACY_TIER[permission](actor));
  });

  it.each(ORG_PERMISSIONS)('billing manager / %s follows the role table', permission => {
    expect(hasOrgPermission(actors.billingManager, org, permission)).toBe(
      ['manageBilling', 'viewUsage'].includes(permission)
    );
  });

  it('gives a billing manager without a roster row nothing', () => {
    expect(hasOrgPermission(actors.billingManager, { ...org, users: [] }, 'manageBilling')).toBe(false);
  });

  it('pins the built-in role table', () => {
    expect(ORG_ROLE_PERMISSIONS).toEqual({
      owner: ORG_PERMISSIONS,
      manager: ['manageMembers', 'managePolicies', 'manageKeys', 'manageContent', 'viewAudit'],
      billingManager: ['manageBilling', 'viewUsage'],
      member: [],
    });
  });
});

describe('orgMemberHasPermission', () => {
  it('has no platform-admin arm', () => {
    expect(orgMemberHasPermission(org, actors.platformAdmin.id, 'manageBilling')).toBe(false);
    expect(hasOrgPermission(actors.platformAdmin, org, 'manageBilling')).toBe(true);
  });

  it('admits the owner and a billing manager to billing', () => {
    expect(orgMemberHasPermission(org, 'owner', 'manageBilling')).toBe(true);
    expect(orgMemberHasPermission(org, 'billing', 'manageBilling')).toBe(true);
    expect(orgMemberHasPermission(org, 'manager', 'manageBilling')).toBe(false);
  });
});

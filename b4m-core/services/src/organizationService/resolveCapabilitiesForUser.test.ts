import { describe, it, expect, vi } from 'vitest';
import type { IGroupDocument, IOrganizationDocument, IUserDocument } from '@bike4mind/common';

// The real GROUP_TYPE_CATALOG carries no `capabilities` (those are product-specific and live in the
// consuming overlay, not open core), so override the lookup with generic test capabilities to
// exercise the union logic. Keys stay generic - no customer name - per the catalog's own rule.
vi.mock('@bike4mind/common', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/common')>();
  const TEST_CATALOG: Record<
    string,
    { key: string; label: string; description: string; priority: number; capabilities?: string[] }
  > = {
    sales: { key: 'sales', label: 'Sales', description: '', priority: 10, capabilities: ['crm:read', 'sales:brief'] },
    research: {
      key: 'research',
      label: 'Research',
      description: '',
      priority: 20,
      capabilities: ['qwork:submit', 'crm:read'],
    },
    customer: { key: 'customer', label: 'Customer', description: '', priority: 30, capabilities: [] },
  };
  return {
    ...actual,
    getGroupType: (key: string) => TEST_CATALOG[key],
    isKnownGroupType: (key: string) => key in TEST_CATALOG,
  };
});

import { resolveCapabilitiesForUser, userHasCapability } from './resolveCapabilitiesForUser';

const ORG = 'org-1';
const OWNER = 'owner-1';

const group = (id: string, type: string): IGroupDocument =>
  ({ id, type, organizationId: ORG, name: type, description: '' }) as unknown as IGroupDocument;

const user = (id: string, groups: string[] | null): Pick<IUserDocument, 'id' | 'groups'> => ({ id, groups });
const admin = (id: string, groups: string[] | null): Pick<IUserDocument, 'id' | 'groups'> & { isAdmin: boolean } => ({
  id,
  groups,
  isAdmin: true,
});

const org = (over: Partial<{ userId: string; allowedGroupTypes: string[] }> = {}): IOrganizationDocument =>
  ({
    id: ORG,
    userId: over.userId ?? OWNER,
    allowedGroupTypes: over.allowedGroupTypes ?? [],
  }) as unknown as IOrganizationDocument;

function makeAdapters(organization: IOrganizationDocument | null, orgGroups: IGroupDocument[]) {
  const findById = vi.fn().mockResolvedValue(organization);
  const findByOrganization = vi.fn().mockResolvedValue(orgGroups);
  return {
    adapters: { db: { organizations: { findById }, groups: { findByOrganization } } },
    findById,
    findByOrganization,
  };
}

describe('resolveCapabilitiesForUser (#1234)', () => {
  it('unions capabilities across the group types a member holds (deduped, sorted)', async () => {
    const { adapters } = makeAdapters(org(), [group('g-sales', 'sales'), group('g-research', 'research')]);
    // sales -> crm:read, sales:brief ; research -> qwork:submit, crm:read ; union deduped + sorted.
    await expect(
      resolveCapabilitiesForUser({ user: user('member-1', ['g-sales', 'g-research']), organizationId: ORG }, adapters)
    ).resolves.toEqual(['crm:read', 'qwork:submit', 'sales:brief']);
  });

  it('fail-closed: a plain member in no group resolves to the empty set', async () => {
    const { adapters } = makeAdapters(org(), [group('g-sales', 'sales')]);
    await expect(
      resolveCapabilitiesForUser({ user: user('member-1', []), organizationId: ORG }, adapters)
    ).resolves.toEqual([]);
  });

  it('fail-closed: a missing / soft-deleted org resolves to empty and never queries groups', async () => {
    const { adapters, findByOrganization } = makeAdapters(null, []);
    await expect(
      resolveCapabilitiesForUser({ user: user('member-1', ['g-sales']), organizationId: ORG }, adapters)
    ).resolves.toEqual([]);
    expect(findByOrganization).not.toHaveBeenCalled();
  });

  it('a group type conferring no capabilities contributes nothing', async () => {
    const { adapters } = makeAdapters(org(), [group('g-customer', 'customer')]);
    await expect(
      resolveCapabilitiesForUser({ user: user('member-1', ['g-customer']), organizationId: ORG }, adapters)
    ).resolves.toEqual([]);
  });

  describe('billing-owner implicit hold (#1226)', () => {
    it("grants the union of the org's GRANTED types even when the owner is in no group", async () => {
      // Owner is never a users[] row, so they hold no groups; they implicitly hold allowedGroupTypes.
      const { adapters } = makeAdapters(org({ allowedGroupTypes: ['sales', 'research'] }), []);
      await expect(
        resolveCapabilitiesForUser({ user: user(OWNER, []), organizationId: ORG }, adapters)
      ).resolves.toEqual(['crm:read', 'qwork:submit', 'sales:brief']);
    });

    it('is the allowedGroupTypes set, NOT the whole catalog', async () => {
      // Granted only `sales` -> owner gets sales caps only, never research/customer.
      const { adapters } = makeAdapters(org({ allowedGroupTypes: ['sales'] }), []);
      await expect(
        resolveCapabilitiesForUser({ user: user(OWNER, []), organizationId: ORG }, adapters)
      ).resolves.toEqual(['crm:read', 'sales:brief']);
    });

    it('ignores an unknown / retired key in allowedGroupTypes', async () => {
      const { adapters } = makeAdapters(org({ allowedGroupTypes: ['sales', 'retired:x'] }), []);
      await expect(
        resolveCapabilitiesForUser({ user: user(OWNER, []), organizationId: ORG }, adapters)
      ).resolves.toEqual(['crm:read', 'sales:brief']);
    });

    it('does NOT grant the implicit set to a non-owner member', async () => {
      // Same org, granted sales+research, but this user is neither the owner nor in any group.
      const { adapters } = makeAdapters(org({ allowedGroupTypes: ['sales', 'research'] }), [group('g-sales', 'sales')]);
      await expect(
        resolveCapabilitiesForUser({ user: user('member-1', []), organizationId: ORG }, adapters)
      ).resolves.toEqual([]);
    });
  });

  describe('platform-admin override (#1236)', () => {
    it('reflects the override persona capabilities for an admin in no group', async () => {
      // Admin holds no groups; override -> resolves as sales+research, so caps are their union.
      const { adapters, findByOrganization } = makeAdapters(org(), []);
      await expect(
        resolveCapabilitiesForUser(
          {
            user: admin('admin-1', []),
            organizationId: ORG,
            override: { organizationId: ORG, groupTypes: ['sales', 'research'] },
          },
          adapters
        )
      ).resolves.toEqual(['crm:read', 'qwork:submit', 'sales:brief']);
      // Override short-circuits the membership read entirely.
      expect(findByOrganization).not.toHaveBeenCalled();
    });

    it('is ignored for a non-admin, who still resolves from real membership', async () => {
      const { adapters } = makeAdapters(org(), [group('g-sales', 'sales')]);
      await expect(
        resolveCapabilitiesForUser(
          {
            user: user('member-1', ['g-sales']),
            organizationId: ORG,
            override: { organizationId: ORG, groupTypes: ['research'] },
          },
          adapters
        )
      ).resolves.toEqual(['crm:read', 'sales:brief']);
    });

    it('forwards the logger so an override resolved through the capability layer is still recorded', async () => {
      const { adapters } = makeAdapters(org(), []);
      const info = vi.fn();
      await resolveCapabilitiesForUser(
        {
          user: admin('admin-1', []),
          organizationId: ORG,
          override: { organizationId: ORG, groupTypes: ['sales'] },
        },
        { ...adapters, logger: { info } }
      );
      expect(info).toHaveBeenCalledTimes(1);
    });

    it('does NOT union the billing-owner implicit hold when the overriding admin IS the org owner', async () => {
      // The likely shape for this affordance: the admin who created the demo org is its `userId`.
      // Unioned, the preview would report sales caps the `customer` persona does not hold.
      const { adapters } = makeAdapters(org({ userId: 'admin-1', allowedGroupTypes: ['sales', 'research'] }), []);
      await expect(
        resolveCapabilitiesForUser(
          {
            user: admin('admin-1', []),
            organizationId: ORG,
            override: { organizationId: ORG, groupTypes: ['customer'] },
          },
          adapters
        )
      ).resolves.toEqual([]); // customer confers nothing; owner's sales/research must NOT leak in
    });

    it('still gives an owner-admin their implicit hold when they pass NO override', async () => {
      // Guards the fix above from over-reaching: skipping the union is override-scoped, not admin-scoped.
      const { adapters } = makeAdapters(org({ userId: 'admin-1', allowedGroupTypes: ['sales'] }), []);
      await expect(
        resolveCapabilitiesForUser({ user: admin('admin-1', []), organizationId: ORG }, adapters)
      ).resolves.toEqual(['crm:read', 'sales:brief']);
    });

    it('keeps the billing-owner hold when the override is ignored (wrong org)', async () => {
      const { adapters } = makeAdapters(org({ userId: 'admin-1', allowedGroupTypes: ['sales'] }), []);
      await expect(
        resolveCapabilitiesForUser(
          {
            user: admin('admin-1', []),
            organizationId: ORG,
            override: { organizationId: 'org-other', groupTypes: ['research'] },
          },
          adapters
        )
      ).resolves.toEqual(['crm:read', 'sales:brief']);
    });

    it('gates userHasCapability off the overridden persona', async () => {
      const { adapters } = makeAdapters(org(), []);
      const params = {
        user: admin('admin-1', []),
        organizationId: ORG,
        override: { organizationId: ORG, groupTypes: ['research'] },
      };
      await expect(userHasCapability({ ...params, capability: 'qwork:submit' }, adapters)).resolves.toBe(true);
      await expect(userHasCapability({ ...params, capability: 'sales:brief' }, adapters)).resolves.toBe(false);
    });
  });

  describe('userHasCapability gate', () => {
    it('is true for a capability the user holds and false otherwise', async () => {
      const { adapters } = makeAdapters(org(), [group('g-sales', 'sales')]);
      const params = { user: user('member-1', ['g-sales']), organizationId: ORG };
      await expect(userHasCapability({ ...params, capability: 'crm:read' }, adapters)).resolves.toBe(true);
      await expect(userHasCapability({ ...params, capability: 'qwork:submit' }, adapters)).resolves.toBe(false);
    });

    it('is false (fail-closed) for a user in no group', async () => {
      const { adapters } = makeAdapters(org(), [group('g-sales', 'sales')]);
      await expect(
        userHasCapability({ user: user('member-1', []), organizationId: ORG, capability: 'crm:read' }, adapters)
      ).resolves.toBe(false);
    });
  });
});

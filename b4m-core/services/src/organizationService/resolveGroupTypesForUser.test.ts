import { describe, it, expect, vi } from 'vitest';
import type { IGroupDocument, IUserDocument } from '@bike4mind/common';
import { resolveGroupTypesForUser } from './resolveGroupTypesForUser';

const ORG = 'org-1';

// Minimal live-group shape as findByOrganization returns it (plain objects with the `id` virtual).
const group = (id: string, type: string, organizationId = ORG): IGroupDocument =>
  ({ id, type, organizationId, name: type, description: '' }) as unknown as IGroupDocument;

const user = (groups: string[] | null): Pick<IUserDocument, 'groups'> => ({ groups });
const admin = (groups: string[] | null): Pick<IUserDocument, 'groups'> & { isAdmin: boolean } => ({
  groups,
  isAdmin: true,
});

function makeAdapters(orgGroups: IGroupDocument[]) {
  const findByOrganization = vi.fn().mockResolvedValue(orgGroups);
  return { adapters: { db: { groups: { findByOrganization } } }, findByOrganization };
}

describe('resolveGroupTypesForUser (#1235)', () => {
  it('returns [] and never queries when the user has no groups', async () => {
    const { adapters, findByOrganization } = makeAdapters([]);
    await expect(resolveGroupTypesForUser({ user: user([]), organizationId: ORG }, adapters)).resolves.toEqual([]);
    await expect(resolveGroupTypesForUser({ user: user(null), organizationId: ORG }, adapters)).resolves.toEqual([]);
    expect(findByOrganization).not.toHaveBeenCalled();
  });

  it("maps the user's group ids to the catalog type keys of the org's live groups", async () => {
    const { adapters } = makeAdapters([group('g-sales', 'sales'), group('g-research', 'research')]);
    await expect(
      resolveGroupTypesForUser({ user: user(['g-sales', 'g-research']), organizationId: ORG }, adapters)
    ).resolves.toEqual(['sales', 'research']);
  });

  it('sorts by catalog priority (lower first), not membership order', async () => {
    // customer=30, sales=10 -> sales must come first regardless of the order held.
    const { adapters } = makeAdapters([group('g-customer', 'customer'), group('g-sales', 'sales')]);
    await expect(
      resolveGroupTypesForUser({ user: user(['g-customer', 'g-sales']), organizationId: ORG }, adapters)
    ).resolves.toEqual(['sales', 'customer']);
  });

  it('excludes group ids the user holds that do not belong to this org (cross-tenant / stale)', async () => {
    // The org only has the sales group; the user also carries a foreign id not returned by this org.
    const { adapters } = makeAdapters([group('g-sales', 'sales')]);
    await expect(
      resolveGroupTypesForUser({ user: user(['g-sales', 'g-other-org']), organizationId: ORG }, adapters)
    ).resolves.toEqual(['sales']);
  });

  it('drops a group whose type is not in the catalog (e.g. a retired type)', async () => {
    const { adapters } = makeAdapters([group('g-sales', 'sales'), group('g-legacy', 'optihashi:compute')]);
    await expect(
      resolveGroupTypesForUser({ user: user(['g-sales', 'g-legacy']), organizationId: ORG }, adapters)
    ).resolves.toEqual(['sales']);
  });

  it('returns membership only for groups the user is actually in', async () => {
    // Org has both types, but the user is only in research.
    const { adapters } = makeAdapters([group('g-sales', 'sales'), group('g-research', 'research')]);
    await expect(
      resolveGroupTypesForUser({ user: user(['g-research']), organizationId: ORG }, adapters)
    ).resolves.toEqual(['research']);
  });

  describe('platform-admin override (#1236)', () => {
    it('resolves AS the override types without a membership read when an admin overrides their own target org', async () => {
      // Admin holds no groups; the override alone confers the types, and priority sort still applies.
      const { adapters, findByOrganization } = makeAdapters([]);
      await expect(
        resolveGroupTypesForUser(
          {
            user: admin([]),
            organizationId: ORG,
            override: { organizationId: ORG, groupTypes: ['customer', 'sales'] },
          },
          adapters
        )
      ).resolves.toEqual(['sales', 'customer']);
      expect(findByOrganization).not.toHaveBeenCalled();
    });

    it('drops unknown override keys and de-duplicates', async () => {
      const { adapters } = makeAdapters([]);
      await expect(
        resolveGroupTypesForUser(
          {
            user: admin([]),
            organizationId: ORG,
            override: { organizationId: ORG, groupTypes: ['sales', 'sales', 'not-a-real-type'] },
          },
          adapters
        )
      ).resolves.toEqual(['sales']);
    });

    it('ignores the override for a non-admin, falling back to real membership', async () => {
      const { adapters } = makeAdapters([group('g-research', 'research')]);
      await expect(
        resolveGroupTypesForUser(
          { user: user(['g-research']), organizationId: ORG, override: { organizationId: ORG, groupTypes: ['sales'] } },
          adapters
        )
      ).resolves.toEqual(['research']);
    });

    it('ignores an override scoped to a different org, falling back to real membership', async () => {
      const { adapters } = makeAdapters([group('g-research', 'research')]);
      await expect(
        resolveGroupTypesForUser(
          {
            user: admin(['g-research']),
            organizationId: ORG,
            override: { organizationId: 'org-other', groupTypes: ['sales'] },
          },
          adapters
        )
      ).resolves.toEqual(['research']);
    });
  });
});

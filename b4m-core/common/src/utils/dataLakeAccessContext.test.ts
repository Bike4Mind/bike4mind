import { describe, it, expect, vi } from 'vitest';
import { buildDataLakeAccessContext } from './dataLakeAccessContext';

function makeResolvers() {
  return {
    membershipOrgIds: vi.fn().mockResolvedValue(['org1', 'org2']),
    entitlementKeys: vi.fn().mockResolvedValue(['ent1']),
    administeredOrgIds: vi.fn().mockResolvedValue(['org1']),
  };
}

describe('buildDataLakeAccessContext', () => {
  it('resolves every set for a regular user', async () => {
    const resolvers = makeResolvers();

    await expect(buildDataLakeAccessContext({ id: 'u1', tags: ['t1'] }, resolvers)).resolves.toEqual({
      userId: 'u1',
      isAdmin: false,
      userTags: ['t1'],
      organizationIds: ['org1', 'org2'],
      entitlementKeys: ['ent1'],
      administeredOrgIds: ['org1'],
    });
  });

  it('skips entitlement and org-admin reads for a platform admin but still resolves membership', async () => {
    const resolvers = makeResolvers();

    const ctx = await buildDataLakeAccessContext({ id: 'u1', isAdmin: true }, resolvers);

    expect(ctx).toEqual({
      userId: 'u1',
      isAdmin: true,
      userTags: [],
      organizationIds: ['org1', 'org2'],
      entitlementKeys: [],
      administeredOrgIds: [],
    });
    expect(resolvers.entitlementKeys).not.toHaveBeenCalled();
    expect(resolvers.administeredOrgIds).not.toHaveBeenCalled();
  });

  it('builds an admin as a member when asMember is set', async () => {
    const resolvers = makeResolvers();

    const ctx = await buildDataLakeAccessContext({ id: 'u1', isAdmin: true }, resolvers, { asMember: true });

    expect(ctx).toMatchObject({ isAdmin: false, entitlementKeys: ['ent1'], administeredOrgIds: ['org1'] });
  });

  it('resolves only entitlement keys for an admin when resolveEntitlementsForAdmin is set', async () => {
    const resolvers = makeResolvers();

    const ctx = await buildDataLakeAccessContext({ id: 'u1', isAdmin: true }, resolvers, {
      resolveEntitlementsForAdmin: true,
    });

    expect(ctx).toMatchObject({ isAdmin: true, entitlementKeys: ['ent1'], administeredOrgIds: [] });
    expect(resolvers.administeredOrgIds).not.toHaveBeenCalled();
  });

  it('defaults null tags to an empty list', async () => {
    const ctx = await buildDataLakeAccessContext({ id: 'u1', tags: null }, makeResolvers());

    expect(ctx.userTags).toEqual([]);
  });
});

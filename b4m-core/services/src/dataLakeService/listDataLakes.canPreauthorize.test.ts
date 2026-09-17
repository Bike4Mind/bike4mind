import { describe, it, expect, vi } from 'vitest';
import type { AccessContext, IDataLakeDocument } from '@bike4mind/common';
import { listDataLakes, listAllDataLakes } from './listDataLakes';

const ctx = (overrides: Partial<AccessContext> = {}): AccessContext => ({
  userId: 'someone',
  isAdmin: false,
  userTags: [],
  organizationIds: [],
  ...overrides,
});

const lake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'lake1',
    name: 'Lake',
    slug: 'lake',
    fileTagPrefix: 'lk:',
    datalakeTag: 'datalake:lake',
    createdByUserId: 'owner',
    status: 'active',
    ...overrides,
  }) as IDataLakeDocument;

const grantRepo = (rows: Record<string, unknown>[] = []) => ({
  listActiveByLakes: vi.fn().mockResolvedValue(rows),
  listByPrincipal: vi.fn().mockResolvedValue([]),
});

describe('listDataLakes / listAllDataLakes - canPreauthorize', () => {
  it('is FALSE for a platform admin holding no other rung, while canManage stays true', async () => {
    // The originally-reported shape: an admin-created lake with no organizationId, whose only manage
    // rung is platform-admin. The affordance must go dark rather than send an id session-create 403s.
    const theirs = lake({ id: 'theirs', slug: 'theirs', createdByUserId: 'someone-else' });
    const db = {
      dataLakes: {
        findIdsCreatedBy: vi.fn().mockResolvedValue([]),
        findAccessible: vi.fn(),
        find: vi.fn().mockResolvedValue([theirs]),
      },
      dataLakeAccessGrants: grantRepo(),
      organizations: { findIdsWithAdminRights: vi.fn().mockResolvedValue([]) },
    };

    const result = await listAllDataLakes(ctx({ userId: 'admin', isAdmin: true }), { db });

    const row = result.find(l => l.id === 'theirs');
    expect(row?.canManage).toBe(true);
    expect(row?.canPreauthorize).toBe(false);
  });

  it('is TRUE for the lake creator', async () => {
    const mine = lake({ id: 'mine', slug: 'mine', createdByUserId: 'me' });
    const db = {
      dataLakes: {
        findIdsCreatedBy: vi.fn().mockResolvedValue([]),
        findAccessible: vi.fn().mockResolvedValue([mine]),
        find: vi.fn(),
      },
      dataLakeAccessGrants: grantRepo(),
    };

    const result = await listDataLakes(ctx({ userId: 'me' }), { db });
    expect(result.find(l => l.id === 'mine')?.canPreauthorize).toBe(true);
  });

  it('is FALSE for a DRAFT lake the caller created, while canManage stays true', async () => {
    // session-create 404s any non-active lake, so the affordance must go dark until the lake's first
    // upload lands - otherwise "test this lake" is offered on exactly the lake it cannot serve.
    const mine = lake({ id: 'mine', slug: 'mine', createdByUserId: 'me', status: 'draft' });
    const db = {
      dataLakes: {
        findIdsCreatedBy: vi.fn().mockResolvedValue([]),
        findAccessible: vi.fn().mockResolvedValue([mine]),
        find: vi.fn(),
      },
      dataLakeAccessGrants: grantRepo(),
    };

    const result = await listDataLakes(ctx({ userId: 'me' }), { db });
    const row = result.find(l => l.id === 'mine');
    expect(row?.canManage).toBe(true);
    expect(row?.canPreauthorize).toBe(false);
  });

  it('is TRUE for a platform admin who ALSO holds a curator grant - the no-code unblock', async () => {
    const theirs = lake({ id: 'theirs', slug: 'theirs', createdByUserId: 'someone-else' });
    const db = {
      dataLakes: {
        findIdsCreatedBy: vi.fn().mockResolvedValue([]),
        findAccessible: vi.fn(),
        find: vi.fn().mockResolvedValue([theirs]),
      },
      dataLakeAccessGrants: grantRepo([
        { dataLakeId: 'theirs', principalType: 'user', principalId: 'admin', role: 'curator' },
      ]),
      organizations: { findIdsWithAdminRights: vi.fn().mockResolvedValue([]) },
    };

    const result = await listAllDataLakes(ctx({ userId: 'admin', isAdmin: true }), { db });
    expect(result.find(l => l.id === 'theirs')?.canPreauthorize).toBe(true);
  });

  it('resolves the org-admin rung for an ADMIN caller, whose ctx.administeredOrgIds is zeroed', async () => {
    // toAccessContext hands admins an empty administeredOrgIds, so reading it off ctx would report a
    // false negative here. The list must re-resolve it, exactly as sessions/create does.
    const orgLake = lake({
      id: 'org-lake',
      slug: 'org-lake',
      createdByUserId: 'someone-else',
      organizationId: 'org-1',
    });
    const db = {
      dataLakes: {
        findIdsCreatedBy: vi.fn().mockResolvedValue([]),
        findAccessible: vi.fn(),
        find: vi.fn().mockResolvedValue([orgLake]),
      },
      dataLakeAccessGrants: grantRepo(),
      organizations: { findIdsWithAdminRights: vi.fn().mockResolvedValue(['org-1']) },
    };

    const result = await listAllDataLakes(ctx({ userId: 'admin', isAdmin: true, administeredOrgIds: [] }), { db });
    expect(result.find(l => l.id === 'org-lake')?.canPreauthorize).toBe(true);
  });

  it('degrades that rung to false when no org repo is wired, rather than over-reporting it', async () => {
    const orgLake = lake({
      id: 'org-lake',
      slug: 'org-lake',
      createdByUserId: 'someone-else',
      organizationId: 'org-1',
    });
    const db = {
      dataLakes: {
        findIdsCreatedBy: vi.fn().mockResolvedValue([]),
        findAccessible: vi.fn(),
        find: vi.fn().mockResolvedValue([orgLake]),
      },
      dataLakeAccessGrants: grantRepo(),
    };

    const result = await listAllDataLakes(ctx({ userId: 'admin', isAdmin: true }), { db });
    expect(result.find(l => l.id === 'org-lake')?.canPreauthorize).toBe(false);
  });

  it('is FALSE for every built-in fallback lake, which session-create could only 404', async () => {
    const db = {
      dataLakes: {
        findIdsCreatedBy: vi.fn().mockResolvedValue([]),
        findAccessible: vi.fn().mockResolvedValue([]),
        find: vi.fn(),
      },
    };
    const result = await listDataLakes(ctx({ userId: 'me', userTags: ['Opti'] }), { db });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every(l => l.canPreauthorize === false)).toBe(true);
  });
});

/**
 * #2945: the admin key-mint picker asks "which lakes may THIS user be bound to", not "which may I
 * admit". Without the override the picker labelled every row with the admin's own rung, so it
 * offered lakes generate-api-key then refused with a 400 ("User does not manage data lake(s)").
 */
describe('listAllDataLakes - preauthorizeForUserId', () => {
  const adminCtx = ctx({ userId: 'admin', isAdmin: true, administeredOrgIds: [] });

  it("resolves the rung against the TARGET, so the target's own lake is bindable", async () => {
    const theirs = lake({ id: 'theirs', slug: 'theirs', createdByUserId: 'target' });
    const db = {
      dataLakes: { findAccessible: vi.fn(), find: vi.fn().mockResolvedValue([theirs]) },
      dataLakeAccessGrants: grantRepo(),
      organizations: { findIdsWithAdminRights: vi.fn().mockResolvedValue([]) },
    };

    const result = await listAllDataLakes(adminCtx, { db, preauthorizeForUserId: 'target' });
    expect(result.find(l => l.id === 'theirs')?.canPreauthorize).toBe(true);
  });

  it("is FALSE for the ADMIN'S OWN lake when scoped to a target who does not manage it", async () => {
    // The reported bug in one assertion: this row is the admin's, canManage is true, and the picker
    // offered it - but the mint route screens it against the target and rejects it.
    const mine = lake({ id: 'mine', slug: 'mine', createdByUserId: 'admin' });
    const db = {
      dataLakes: { findAccessible: vi.fn(), find: vi.fn().mockResolvedValue([mine]) },
      dataLakeAccessGrants: grantRepo(),
      organizations: { findIdsWithAdminRights: vi.fn().mockResolvedValue([]) },
    };

    const result = await listAllDataLakes(adminCtx, { db, preauthorizeForUserId: 'target' });
    const row = result.find(l => l.id === 'mine');
    expect(row?.canManage).toBe(true);
    expect(row?.canPreauthorize).toBe(false);
  });

  it("resolves the org-admin rung from the TARGET'S org rights, never the caller's", async () => {
    const orgLake = lake({
      id: 'org-lake',
      slug: 'org-lake',
      createdByUserId: 'someone-else',
      organizationId: 'org-1',
    });
    const findIdsWithAdminRights = vi.fn().mockImplementation((userId: string) =>
      // Only the target administers org-1. Reusing the caller's set here would report the admin's
      // org rungs as the target's, which is the mislabeling the option exists to remove.
      Promise.resolve(userId === 'target' ? ['org-1'] : [])
    );
    const db = {
      dataLakes: { findAccessible: vi.fn(), find: vi.fn().mockResolvedValue([orgLake]) },
      dataLakeAccessGrants: grantRepo(),
      organizations: { findIdsWithAdminRights },
    };

    const result = await listAllDataLakes(adminCtx, { db, preauthorizeForUserId: 'target' });
    expect(findIdsWithAdminRights).toHaveBeenCalledWith('target');
    expect(findIdsWithAdminRights).not.toHaveBeenCalledWith('admin');
    expect(result.find(l => l.id === 'org-lake')?.canPreauthorize).toBe(true);
  });

  it("still refuses a DRAFT lake the target created, matching the mint route's active-only screen", async () => {
    const draft = lake({ id: 'draft', slug: 'draft', createdByUserId: 'target', status: 'draft' });
    const db = {
      dataLakes: { findAccessible: vi.fn(), find: vi.fn().mockResolvedValue([draft]) },
      dataLakeAccessGrants: grantRepo(),
      organizations: { findIdsWithAdminRights: vi.fn().mockResolvedValue([]) },
    };

    const result = await listAllDataLakes(adminCtx, { db, preauthorizeForUserId: 'target' });
    expect(result.find(l => l.id === 'draft')?.canPreauthorize).toBe(false);
  });

  it("treats a BLANK id as absent rather than pairing nobody with the caller's org rungs", async () => {
    // preauthorizeOrgIdsFor falls through on a falsy override, so an unnormalized '' would resolve
    // the admin's own org rights and attribute them to an empty identity - an admission no user has.
    const orgLake = lake({
      id: 'org-lake',
      slug: 'org-lake',
      createdByUserId: 'someone-else',
      organizationId: 'org-1',
    });
    const findIdsWithAdminRights = vi.fn().mockResolvedValue(['org-1']);
    const db = {
      dataLakes: { findAccessible: vi.fn(), find: vi.fn().mockResolvedValue([orgLake]) },
      dataLakeAccessGrants: grantRepo(),
      organizations: { findIdsWithAdminRights },
    };

    const result = await listAllDataLakes(adminCtx, { db, preauthorizeForUserId: '' });

    expect(findIdsWithAdminRights).toHaveBeenCalledWith('admin');
    expect(findIdsWithAdminRights).not.toHaveBeenCalledWith('');
    expect(result.find(l => l.id === 'org-lake')?.canPreauthorize).toBe(true);
  });

  it('leaves the caller-scoped behaviour untouched when the option is absent', async () => {
    const mine = lake({ id: 'mine', slug: 'mine', createdByUserId: 'admin' });
    const db = {
      dataLakes: { findAccessible: vi.fn(), find: vi.fn().mockResolvedValue([mine]) },
      dataLakeAccessGrants: grantRepo(),
      organizations: { findIdsWithAdminRights: vi.fn().mockResolvedValue([]) },
    };

    const result = await listAllDataLakes(adminCtx, { db });
    expect(result.find(l => l.id === 'mine')?.canPreauthorize).toBe(true);
  });
});

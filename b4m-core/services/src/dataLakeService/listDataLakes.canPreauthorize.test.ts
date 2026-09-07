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
      dataLakes: { findAccessible: vi.fn(), find: vi.fn().mockResolvedValue([theirs]) },
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
      dataLakes: { findAccessible: vi.fn().mockResolvedValue([mine]), find: vi.fn() },
      dataLakeAccessGrants: grantRepo(),
    };

    const result = await listDataLakes(ctx({ userId: 'me' }), { db });
    expect(result.find(l => l.id === 'mine')?.canPreauthorize).toBe(true);
  });

  it('is TRUE for a platform admin who ALSO holds a curator grant - the no-code unblock', async () => {
    const theirs = lake({ id: 'theirs', slug: 'theirs', createdByUserId: 'someone-else' });
    const db = {
      dataLakes: { findAccessible: vi.fn(), find: vi.fn().mockResolvedValue([theirs]) },
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
      dataLakes: { findAccessible: vi.fn(), find: vi.fn().mockResolvedValue([orgLake]) },
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
      dataLakes: { findAccessible: vi.fn(), find: vi.fn().mockResolvedValue([orgLake]) },
      dataLakeAccessGrants: grantRepo(),
    };

    const result = await listAllDataLakes(ctx({ userId: 'admin', isAdmin: true }), { db });
    expect(result.find(l => l.id === 'org-lake')?.canPreauthorize).toBe(false);
  });

  it('is FALSE for every built-in fallback lake, which session-create could only 404', async () => {
    const db = { dataLakes: { findAccessible: vi.fn().mockResolvedValue([]), find: vi.fn() } };
    const result = await listDataLakes(ctx({ userId: 'me', userTags: ['Opti'] }), { db });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every(l => l.canPreauthorize === false)).toBe(true);
  });
});

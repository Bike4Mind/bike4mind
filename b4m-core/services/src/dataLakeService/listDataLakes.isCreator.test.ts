import { describe, it, expect, vi } from 'vitest';
import type { AccessContext, IDataLakeDocument } from '@bike4mind/common';
import { listDataLakes, listAllDataLakes } from './listDataLakes';

const ctx = (overrides: Partial<AccessContext> = {}): AccessContext => ({
  userId: 'alice',
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
    createdByUserId: 'alice',
    organizationId: 'orgA',
    status: 'active',
    ...overrides,
  }) as IDataLakeDocument;

const repos = (lakes: IDataLakeDocument[], grants: unknown[] = []) => ({
  dataLakes: {
    findAccessible: vi.fn().mockResolvedValue(lakes),
    find: vi.fn().mockResolvedValue(lakes),
    findIdsCreatedBy: vi.fn().mockResolvedValue([]),
  },
  dataLakeAccessGrants: {
    listActiveByLakes: vi.fn().mockResolvedValue(grants),
    listByPrincipal: vi.fn().mockResolvedValue([]),
  },
});

describe('isCreator on the manager list', () => {
  it('is true for the lake creator', async () => {
    const result = await listDataLakes(ctx(), { db: repos([lake()]) });
    expect(result.find(l => l.id === 'lake1')).toMatchObject({ isCreator: true, isOwn: true });
  });

  it('is false for a transferred owner, who stays isOwn but is not the creator', async () => {
    const grants = [{ dataLakeId: 'lake1', principalType: 'user', principalId: 'bob', role: 'owner' }];
    const result = await listDataLakes(ctx({ userId: 'bob' }), { db: repos([lake()], grants) });
    expect(result.find(l => l.id === 'lake1')).toMatchObject({ isCreator: false, isOwn: true });
  });

  it('is false for an admin viewing someone else lake, and false on a built-in fallback lake', async () => {
    const result = await listAllDataLakes(ctx({ userId: 'admin', isAdmin: true }), { db: repos([lake()]) });
    expect(result.find(l => l.id === 'lake1')?.isCreator).toBe(false);
    expect(result.find(l => l.id === 'opti-knowledge')?.isCreator).toBe(false);
  });
});

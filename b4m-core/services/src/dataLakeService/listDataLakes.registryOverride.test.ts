import { describe, it, expect, vi } from 'vitest';
import { DATA_LAKES, type AccessContext, type IDataLakeDocument } from '@bike4mind/common';
import { listDataLakes, listAllDataLakes } from './listDataLakes';

const REGISTRY_KEY = DATA_LAKES[0].id;

const ctx = (overrides: Partial<AccessContext> = {}): AccessContext => ({
  userId: 'me',
  isAdmin: true,
  userTags: DATA_LAKES[0].requiredUserTag ? [DATA_LAKES[0].requiredUserTag] : [],
  organizationIds: [],
  ...overrides,
});

const lake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'lake1',
    name: 'Lake',
    slug: REGISTRY_KEY,
    fileTagPrefix: 'lk:',
    datalakeTag: 'datalake:lake',
    createdByUserId: 'other',
    status: 'active',
    ...overrides,
  }) as IDataLakeDocument;

const dbWith = (dynamic: IDataLakeDocument[]) => ({
  dataLakes: {
    findIdsCreatedBy: vi.fn().mockResolvedValue([]),
    findAccessible: vi.fn().mockResolvedValue(dynamic),
    find: vi.fn().mockResolvedValue(dynamic),
  },
});

describe('listDataLakes / listAllDataLakes - which DB lakes replace a registry lake', () => {
  it('keeps the registry lake listed beside an org-less DB lake holding its id', async () => {
    const orgless = lake({ id: 'orgless', isPublic: true });

    const listed = await listDataLakes(ctx(), { db: dbWith([orgless]) });
    const all = await listAllDataLakes(ctx(), { db: dbWith([orgless]) });

    expect(listed.map(l => l.id)).toEqual(expect.arrayContaining(['orgless', REGISTRY_KEY]));
    expect(all.map(l => l.id)).toEqual(expect.arrayContaining(['orgless', REGISTRY_KEY]));
  });

  it('lets an org-scoped DB lake holding the id take its place', async () => {
    const own = lake({ id: 'own', organizationId: 'orgA', createdByUserId: 'me' });

    const listed = await listDataLakes(ctx({ organizationIds: ['orgA'] }), { db: dbWith([own]) });

    expect(listed.map(l => l.id)).toContain('own');
    expect(listed.map(l => l.id)).not.toContain(REGISTRY_KEY);
  });
});

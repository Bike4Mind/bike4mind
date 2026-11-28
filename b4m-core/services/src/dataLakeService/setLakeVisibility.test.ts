import { describe, it, expect, vi } from 'vitest';
import { DATA_LAKES, type IDataLakeDocument } from '@bike4mind/common';
import { setLakeVisibility } from './setLakeVisibility';

const REGISTRY_KEY = DATA_LAKES[0].id;

const lake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'lake1',
    name: 'Lake',
    slug: 'lake',
    fileTagPrefix: 'lk:',
    datalakeTag: 'datalake:orgA:lake',
    createdByUserId: 'owner',
    status: 'active',
    organizationId: 'orgA',
    ...overrides,
  }) as IDataLakeDocument;

const makeDb = (existing: IDataLakeDocument) => ({
  dataLakes: {
    findById: vi.fn().mockResolvedValue(existing),
    find: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockImplementation(async (d: Partial<IDataLakeDocument>) => ({ ...existing, ...d })),
  },
  dataLakeAccessGrants: { listByLake: vi.fn().mockResolvedValue([]) },
  orgGoogleDriveConnections: { findByDataLakeIdAny: vi.fn().mockResolvedValue(null) },
  orgGitHubLakeConnections: { findByDataLakeIdAny: vi.fn().mockResolvedValue(null) },
  lakeConfigChangeEvents: { create: vi.fn().mockResolvedValue({}) },
});

const owner = { userId: 'owner', isAdmin: false, organizationId: 'orgA' };

describe('setLakeVisibility - registry lake keys stay org-scoped', () => {
  it.each(['private', 'public'] as const)(
    'refuses moving an org lake holding a registry key to %s',
    async visibility => {
      const db = makeDb(lake({ slug: REGISTRY_KEY, datalakeTag: `datalake:orgA:${REGISTRY_KEY}` }));
      await expect(setLakeVisibility(owner, 'lake1', visibility, { db } as never)).rejects.toThrow(
        /reserved by a built-in knowledge base/
      );
      expect(db.dataLakes.update).not.toHaveBeenCalled();
    }
  );

  it('still moves an org lake with an ordinary slug out of the org', async () => {
    const db = makeDb(lake());
    await setLakeVisibility(owner, 'lake1', 'private', { db } as never);
    expect(db.dataLakes.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'lake1', organizationId: null }));
  });

  it('still lets an org-less lake holding a registry key move into an org', async () => {
    const db = makeDb(
      lake({ slug: REGISTRY_KEY, organizationId: undefined, datalakeTag: `datalake:orgB:${REGISTRY_KEY}` })
    );
    await setLakeVisibility(owner, 'lake1', 'organization', { db } as never);
    expect(db.dataLakes.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'lake1', organizationId: 'orgA' }));
  });
});

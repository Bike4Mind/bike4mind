import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeDocument } from '@bike4mind/common';
import { browsePublicDataLakes } from './browsePublicDataLakes';

/**
 * The discover catalog's creator arm does not merely ADMIT a lake - it LIFTS the requirement gate
 * for "its owner", which is the one arm that can show a caller a lake gated behind a tag they do not
 * hold. On bare `createdByUserId` that privilege outlives ownership, because the field is immutable.
 *
 * The row set is the subject here; the query arm is pinned against real Mongo
 * (DataLakeModel.ownerSupersession.test.ts). Note the pre-existing asymmetry this closes: `isOwn`
 * on each card already resolves through `isEffectiveOwner`, so before this the catalog could hand a
 * superseded creator a row it simultaneously labelled as not theirs.
 */

const publicLake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'atlas',
    slug: 'atlas',
    name: 'Atlas',
    fileTagPrefix: 'atlas:',
    datalakeTag: 'datalake:atlas',
    createdByUserId: 'alice',
    status: 'active',
    isPublic: true,
    ...overrides,
  }) as IDataLakeDocument;

const adapters = (ownerOfAtlas: string) => {
  const findPublicLakes = vi.fn().mockResolvedValue({ lakes: [publicLake()], total: 1 });
  const db = {
    dataLakes: { findPublicLakes, findIdsCreatedBy: vi.fn().mockResolvedValue(['atlas']) },
    users: { findByIds: vi.fn().mockResolvedValue([]) },
    dataLakeAccessGrants: {
      listByPrincipal: vi.fn().mockResolvedValue([]),
      listActiveByLakes: vi
        .fn()
        .mockResolvedValue([{ dataLakeId: 'atlas', principalType: 'user', principalId: ownerOfAtlas, role: 'owner' }]),
    },
    settings: { getSettingsValue: vi.fn().mockResolvedValue(false) },
  };
  return { db, findPublicLakes };
};

const actor = { userId: 'alice', isAdmin: false, userTags: [], organizationIds: [], entitlementKeys: [] };

describe('discover catalog - a creator superseded as owner stops getting the gate lifted', () => {
  it('passes the exclusion to the catalog query', async () => {
    const { db, findPublicLakes } = adapters('billing-owner');

    await browsePublicDataLakes(actor, {}, { db } as never);

    expect(findPublicLakes).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ supersededOwnLakeIds: ['atlas'] })
    );
  });

  it('passes an empty exclusion while the caller is still the effective owner', async () => {
    const { db, findPublicLakes } = adapters('alice');

    await browsePublicDataLakes(actor, {}, { db } as never);

    expect(findPublicLakes).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ supersededOwnLakeIds: [] })
    );
  });

  it('skips the resolution entirely for an admin, whose catalog emits no per-caller arm', async () => {
    const { db, findPublicLakes } = adapters('billing-owner');

    await browsePublicDataLakes({ ...actor, isAdmin: true }, {}, { db } as never);

    expect(db.dataLakes.findIdsCreatedBy).not.toHaveBeenCalled();
    expect(findPublicLakes).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ supersededOwnLakeIds: [] })
    );
  });
});

import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeDocument } from '@bike4mind/common';
import { getDynamicDataLakeAccess, type DataLakeAccessContext } from './getDynamicDataLakeTags';

const dbLake = (overrides: Partial<IDataLakeDocument> & Pick<IDataLakeDocument, 'id'>): IDataLakeDocument =>
  ({
    name: overrides.id,
    slug: overrides.id,
    fileTagPrefix: `${overrides.id}:`,
    datalakeTag: `datalake:${overrides.id}`,
    createdByUserId: 'admin',
    status: 'active',
    ...overrides,
  }) as IDataLakeDocument;

// Mocks the DB pre-filter, then asserts the in-memory filter (getAccessibleDataLakes) is
// the real authority - even when the DB layer over-returns, an entitlement-gated lake is
// only surfaced to a key holder.
const ctx = (lakes: IDataLakeDocument[], over: Partial<DataLakeAccessContext> = {}): DataLakeAccessContext => ({
  db: { dataLakes: { findActiveByUserTagsAndEntitlements: vi.fn().mockResolvedValue(lakes) } as never },
  user: { tags: [] },
  ...over,
});

describe('getDynamicDataLakeAccess — entitlement-aware lake resolution', () => {
  it('surfaces an entitlement-gated lake to a tag-less subscriber holding the key', async () => {
    const lakes = [dbLake({ id: 'medlib', requiredUserTag: 'medlib', requiredEntitlement: 'medlib:pro' })];
    const res = await getDynamicDataLakeAccess(ctx(lakes, { user: { tags: [] }, entitlementKeys: ['medlib:pro'] }));
    expect(res.dataLakeTags).toEqual(['datalake:medlib']);
    // A DYNAMIC (DB) lake's user-controlled prefix is SCOPED, never OPEN - it can only be
    // matched within owner/org access, never as a bare ownership bypass.
    expect(res.dataLakeTagPrefixes).toEqual([]);
    expect(res.scopedTagPrefixes).toEqual(['medlib:']);
  });

  it('surfaces the same lake to a comp-tag holder with no entitlement keys (via the tag)', async () => {
    const lakes = [dbLake({ id: 'medlib', requiredUserTag: 'medlib', requiredEntitlement: 'medlib:pro' })];
    const res = await getDynamicDataLakeAccess(ctx(lakes, { user: { tags: ['medlib'] }, entitlementKeys: [] }));
    expect(res.dataLakeTags).toEqual(['datalake:medlib']);
  });

  it('the in-memory filter gates even when the DB over-returns (no key, no tag → empty)', async () => {
    // DB mock returns the lake regardless; the filter must still exclude it.
    const lakes = [dbLake({ id: 'medlib', requiredEntitlement: 'medlib:pro' })];
    const res = await getDynamicDataLakeAccess(ctx(lakes, { user: { tags: [] }, entitlementKeys: [] }));
    expect(res.dataLakeTags).toEqual([]);
    expect(res.dataLakeTagPrefixes).toEqual([]);
  });

  it('falls back to static lakes (and never throws) when the dataLakes repo is absent', async () => {
    const res = await getDynamicDataLakeAccess({ db: {}, user: { tags: ['Opti'] } });
    // Static DATA_LAKES: the opti lake requires the Opti tag.
    expect(res.dataLakeTags.sort()).toEqual(['datalake:opti-knowledge']);
  });

  it('threads the caller organizationId + id into the DB pre-filter (scoping happens there)', async () => {
    const spy = vi.fn().mockResolvedValue([]);
    await getDynamicDataLakeAccess({
      db: { dataLakes: { findActiveByUserTagsAndEntitlements: spy } as never },
      user: { id: 'u1', tags: ['x'], organizationId: 'org123' },
      entitlementKeys: ['k:pro'],
    });
    expect(spy).toHaveBeenCalledWith(['x'], ['k:pro'], 'org123', 'u1');
  });

  it('passes undefined org/id for an org-less, id-less caller (only org-less gated lakes resolve)', async () => {
    const spy = vi.fn().mockResolvedValue([]);
    await getDynamicDataLakeAccess({
      db: { dataLakes: { findActiveByUserTagsAndEntitlements: spy } as never },
      user: { tags: [] },
    });
    expect(spy).toHaveBeenCalledWith([], [], undefined, undefined);
  });

  it('string-coerces non-string organizationId + id (hydrated ObjectIds) before querying', async () => {
    const spy = vi.fn().mockResolvedValue([]);
    // Simulates a hydrated user doc carrying ObjectIds - no cast needed now that the
    // context type accepts ObjectId-like values.
    await getDynamicDataLakeAccess({
      db: { dataLakes: { findActiveByUserTagsAndEntitlements: spy } as never },
      user: { id: { toString: () => 'user-oid' }, tags: [], organizationId: { toString: () => 'org-oid' } },
    });
    expect(spy).toHaveBeenCalledWith([], [], 'org-oid', 'user-oid');
  });
});

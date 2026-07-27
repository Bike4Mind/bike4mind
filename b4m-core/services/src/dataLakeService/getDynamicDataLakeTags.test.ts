import { describe, it, expect, vi } from 'vitest';
import { DATA_LAKES, type IDataLakeDocument } from '@bike4mind/common';
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

// Mocks the DB pre-filter, then asserts the in-memory filter (getAccessibleDataLakes) is the
// real authority for lakes the caller does NOT own - even when the DB layer over-returns, an
// entitlement-gated lake is only surfaced to a key holder. A lake the caller created is the one
// exception, and its ownership is re-verified in memory rather than taken from the query.
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

  it('drops a DB lake that carries a static-registry meta-tag, gate or no gate', async () => {
    // The registry has no Mongo documents, so the unique index on datalakeTag cannot catch a
    // row minting `datalake:<registry-slug>`. Its creator would otherwise reach every tenant's
    // files in that registry lake, because the meta-tag arm bypasses ownership.
    const reserved = DATA_LAKES[0].datalakeTag;
    const shadow = dbLake({ id: 'db-oid', slug: 'shadow', fileTagPrefix: 'mine:', datalakeTag: reserved });

    const res = await getDynamicDataLakeAccess(ctx([shadow], { user: { id: 'mallory', tags: [] } }));

    expect(res.dataLakeTags).not.toContain(reserved);
    expect(res.dataLakeTags).toEqual([]);
    // Its own prefix is still scoped to the owner, which stays legitimate.
    expect(res.scopedTagPrefixes).toEqual(['mine:']);
    expect(res.dataLakeTagPrefixes).toEqual([]);
  });

  it('reports a swallowed dataLakes read failure instead of silently going static-only', async () => {
    const warn = vi.fn();
    const failing = { findActiveByUserTagsAndEntitlements: vi.fn().mockRejectedValue(new Error('mongo down')) };

    const res = await getDynamicDataLakeAccess({
      db: { dataLakes: failing as never },
      user: { tags: ['Opti'] },
      entitlementKeys: [],
      logger: { warn } as never,
    });

    expect(warn).toHaveBeenCalled();
    // Degrades to the static registry rather than throwing - narrowing, never widening.
    expect(res.scopedTagPrefixes).toEqual([]);
  });

  it('keeps a normal DB lake tag - the drop targets registry collisions only', async () => {
    const res = await getDynamicDataLakeAccess(ctx([dbLake({ id: 'ordinary' })], { user: { tags: [] } }));

    expect(res.dataLakeTags).toEqual(['datalake:ordinary']);
  });

  it('restores a gated lake the CALLER OWNS - the DB owner bypass survives the in-memory filter', async () => {
    // The DB layer returns it via the owner arm; getAccessibleDataLakes has no ownership rule
    // and would drop it, so the resolver re-adds it. Browse (apps/client/server/dataLakes) never
    // ran that second pass, so this is what makes /articles and retrieval agree on an owner's
    // own gated lake.
    const own = dbLake({ id: 'mine', createdByUserId: 'owner', requiredUserTag: 'SomeTagIDoNotHold' });

    const res = await getDynamicDataLakeAccess(ctx([own], { user: { id: 'owner', tags: [] } }));

    expect(res.dataLakeTags).toEqual(['datalake:mine']);
    expect(res.scopedTagPrefixes).toEqual(['mine:']);
    expect(res.dataLakeTagPrefixes).toEqual([]);
  });

  it('still drops a gated lake the caller does NOT own, even with a userId supplied', async () => {
    // The exemption must key off the persisted creator, not off "the query returned it". This is
    // the case that fails if the owned set is ever reduced to "everything the DB handed back".
    const theirs = dbLake({ id: 'theirs', createdByUserId: 'someone-else', requiredUserTag: 'TagIDoNotHold' });

    const res = await getDynamicDataLakeAccess(ctx([theirs], { user: { id: 'mallory', tags: [] } }));

    expect(res.dataLakeTags).toEqual([]);
    expect(res.scopedTagPrefixes).toEqual([]);
    expect(res.dataLakeTagPrefixes).toEqual([]);
  });

  it('does not treat a creator-less lake as owned by an id-less caller', async () => {
    // Both sides absent is the fail-open shape: comparing String(undefined) to String(undefined)
    // would make every ownerless gated lake look owned by every anonymous caller. A blank creator
    // is a real value - resolveFallbackLake mints one.
    const blank = dbLake({ id: 'blank', createdByUserId: '', requiredUserTag: 'TagIDoNotHold' });
    const absent = dbLake({ id: 'absent', requiredUserTag: 'TagIDoNotHold' });
    delete (absent as { createdByUserId?: string }).createdByUserId;

    const res = await getDynamicDataLakeAccess(ctx([blank, absent], { user: { tags: [] } }));

    expect(res.dataLakeTags).toEqual([]);
    expect(res.scopedTagPrefixes).toEqual([]);
  });

  it('strips the reserved meta-tag of a shadow lake even when the caller owns it', async () => {
    // The exemption must not re-open the registry-shadow escalation: the re-add happens upstream
    // of the reserved-tag drop, so an owned shadow lake keeps its own prefix and loses the tag.
    const reserved = DATA_LAKES[0].datalakeTag;
    const ownedShadow = dbLake({
      id: 'owned-shadow',
      fileTagPrefix: 'mine:',
      datalakeTag: reserved,
      createdByUserId: 'mallory',
      requiredUserTag: 'TagIDoNotHold',
    });

    const res = await getDynamicDataLakeAccess(ctx([ownedShadow], { user: { id: 'mallory', tags: [] } }));

    expect(res.dataLakeTags).toEqual([]);
    // The prefix proves the lake WAS restored and then had its tag stripped, rather than the
    // exemption simply never running.
    expect(res.scopedTagPrefixes).toEqual(['mine:']);
  });

  it('lists an owned lake once when it also satisfies its own gate', async () => {
    const own = dbLake({ id: 'mine', createdByUserId: 'owner', requiredUserTag: 'medlib' });

    const res = await getDynamicDataLakeAccess(ctx([own], { user: { id: 'owner', tags: ['medlib'] } }));

    // toEqual, not toContain: a duplicate re-add would slip past a containment check.
    expect(res.dataLakeTags).toEqual(['datalake:mine']);
    expect(res.scopedTagPrefixes).toEqual(['mine:']);
  });

  it('matches an ObjectId-like user.id against the string createdByUserId', async () => {
    const own = dbLake({ id: 'mine', createdByUserId: 'user-oid', requiredUserTag: 'TagIDoNotHold' });

    const res = await getDynamicDataLakeAccess(ctx([own], { user: { id: { toString: () => 'user-oid' }, tags: [] } }));

    // Asserts the re-add outcome, not what was handed to the query - a raw === against the
    // uncoerced context value would compare an object to a string and silently drop the lake.
    expect(res.dataLakeTags).toEqual(['datalake:mine']);
  });
});

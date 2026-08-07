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

  it('normalizes an ObjectId organizationId (and string-coerces id) before querying', async () => {
    const spy = vi.fn().mockResolvedValue([]);
    // Simulates a hydrated user doc: organizationId arrives as an ObjectId (exposes toHexString),
    // id as an ObjectId-like value. normalizeId yields the org hex; id keeps its String() coercion.
    await getDynamicDataLakeAccess({
      db: { dataLakes: { findActiveByUserTagsAndEntitlements: spy } as never },
      user: { id: { toString: () => 'user-oid' }, tags: [], organizationId: { toHexString: () => 'org-oid' } },
    });
    expect(spy).toHaveBeenCalledWith([], [], 'org-oid', 'user-oid');
  });

  it('normalizes a POPULATED-document organizationId to its hex, never "[object Object]" (#1343)', async () => {
    const spy = vi.fn().mockResolvedValue([]);
    // A .populate('organizationId') upstream would hand a full Organization doc here. Raw String()
    // would make the org filter "[object Object]" and match no org lake; normalizeId reads its _id.
    await getDynamicDataLakeAccess({
      db: { dataLakes: { findActiveByUserTagsAndEntitlements: spy } as never },
      user: { tags: [], organizationId: { _id: { toHexString: () => 'org-hex' }, name: 'Acme' } },
    });
    expect(spy).toHaveBeenCalledWith([], [], 'org-hex', undefined);
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

  it("does not match an id-less caller against a creator stored as the string 'undefined'", async () => {
    // The fail-open shape is coercing BOTH sides: String(undefined) is 'undefined', which equals
    // a creator field literally holding 'undefined' - a plausible bad-ingest value, and one the
    // schema accepts since it is a non-empty string. Only the document side may be coerced.
    const corrupt = dbLake({ id: 'corrupt', createdByUserId: 'undefined', requiredUserTag: 'TagIDoNotHold' });

    const res = await getDynamicDataLakeAccess(ctx([corrupt], { user: { tags: [] } }));

    expect(res.dataLakeTags).toEqual([]);
    expect(res.scopedTagPrefixes).toEqual([]);
  });

  it('strips the reserved meta-tag of a shadow lake even when the caller owns it', async () => {
    // The exemption must not re-open the registry-shadow escalation. The reachable shadow is
    // slug-based - a row slugged after a registry lake mints that lake's meta-tag and is
    // therefore WELL-FORMED, so it passes the self-consistency check and really is restored.
    // The re-add sits upstream of the reserved-tag drop, so it keeps its prefix and loses the tag.
    const ownedShadow = dbLake({
      id: 'owned-shadow',
      slug: DATA_LAKES[0].slug,
      fileTagPrefix: 'mine:',
      datalakeTag: DATA_LAKES[0].datalakeTag,
      createdByUserId: 'mallory',
      requiredUserTag: 'TagIDoNotHold',
    });

    const res = await getDynamicDataLakeAccess(ctx([ownedShadow], { user: { id: 'mallory', tags: [] } }));

    expect(res.dataLakeTags).toEqual([]);
    // The prefix proves the lake WAS restored and then had its tag stripped, rather than the
    // exemption simply never running.
    expect(res.scopedTagPrefixes).toEqual(['mine:']);
  });

  it('refuses to restore an owned lake whose meta-tag its own slug would not mint', async () => {
    // A row where datalakeTag and slug disagree did not come through createDataLake. The
    // reserved-tag check only knows the registry this runtime can see, so well-formedness is the
    // environment-independent half of that defense - it must gate the privileged restore.
    const malformed = dbLake({
      id: 'malformed',
      slug: 'mine',
      datalakeTag: 'datalake:something-else',
      createdByUserId: 'owner',
      requiredUserTag: 'TagIDoNotHold',
    });

    const res = await getDynamicDataLakeAccess(ctx([malformed], { user: { id: 'owner', tags: [] } }));

    expect(res.dataLakeTags).toEqual([]);
    expect(res.scopedTagPrefixes).toEqual([]);
  });

  it('restores an owned ORG lake, whose meta-tag is namespaced by org', async () => {
    // Well-formedness must account for the org namespace, or the check would reject every
    // legitimate org lake.
    const orgLake = dbLake({
      id: 'orgmine',
      slug: 'handbook',
      organizationId: 'orgA',
      datalakeTag: 'datalake:orgA:handbook',
      fileTagPrefix: 'hb:',
      createdByUserId: 'owner',
      requiredUserTag: 'TagIDoNotHold',
    });

    const res = await getDynamicDataLakeAccess(
      ctx([orgLake], { user: { id: 'owner', tags: [], organizationId: 'orgA' } })
    );

    expect(res.dataLakeTags).toEqual(['datalake:orgA:handbook']);
    expect(res.scopedTagPrefixes).toEqual(['hb:']);
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

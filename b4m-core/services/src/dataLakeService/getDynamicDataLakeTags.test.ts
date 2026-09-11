import { describe, it, expect, vi } from 'vitest';
import { DATA_LAKES, type IDataLakeDocument } from '@bike4mind/common';
import {
  getDynamicDataLakeAccess,
  lakeMembershipsFrom,
  type DataLakeAccessContext,
  type ResolvedLakeAccess,
} from './getDynamicDataLakeTags';
import { registryMembershipScope } from './lakeMembershipScope';

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
//
// `organizationIds` stands in for the caller's membership set (what `db.organizations.
// findMembershipOrgIds` would resolve) - default empty (member of nothing) unless a test
// needs an org lake to resolve.
const ctx = (
  lakes: IDataLakeDocument[],
  over: Partial<DataLakeAccessContext> = {},
  organizationIds: string[] = []
): DataLakeAccessContext => ({
  db: {
    dataLakes: { findActiveByUserTagsAndEntitlements: vi.fn().mockResolvedValue(lakes) } as never,
    organizations: { findMembershipOrgIds: vi.fn().mockResolvedValue(organizationIds) },
  },
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
    const res = await getDynamicDataLakeAccess({
      db: { organizations: { findMembershipOrgIds: vi.fn().mockResolvedValue([]) } },
      user: { tags: ['Opti'] },
    });
    // Static DATA_LAKES: the opti lake requires the Opti tag.
    expect(res.dataLakeTags.sort()).toEqual(['datalake:opti-knowledge']);
    // An absent repo is NOT a degraded view: there are no dynamic lakes to have missed, so this
    // registry-only answer is the whole picture and may be used to prove a tag unreachable.
    expect(res.lakeViewComplete).toBe(true);
  });

  it('resolves the membership set via db.organizations and passes it to the collection query', async () => {
    const findActive = vi.fn().mockResolvedValue([]);
    await getDynamicDataLakeAccess({
      db: {
        dataLakes: { findActiveByUserTagsAndEntitlements: findActive } as never,
        organizations: { findMembershipOrgIds: vi.fn().mockResolvedValue(['org-a', 'org-b']) },
      },
      user: { id: 'u1', tags: [] },
      entitlementKeys: [],
    } as never);
    expect(findActive).toHaveBeenCalledWith([], [], ['org-a', 'org-b'], 'u1', {
      grantedLakeIds: [],
      orgGrantedLakes: {},
    });
  });

  it('threads entitlementKeys and tags into the DB pre-filter alongside the resolved membership set', async () => {
    const spy = vi.fn().mockResolvedValue([]);
    const findMembershipOrgIds = vi.fn().mockResolvedValue(['org123']);
    await getDynamicDataLakeAccess({
      db: { dataLakes: { findActiveByUserTagsAndEntitlements: spy } as never, organizations: { findMembershipOrgIds } },
      user: { id: 'u1', tags: ['x'] },
      entitlementKeys: ['k:pro'],
    });
    expect(findMembershipOrgIds).toHaveBeenCalledWith('u1');
    expect(spy).toHaveBeenCalledWith(['x'], ['k:pro'], ['org123'], 'u1', { grantedLakeIds: [], orgGrantedLakes: {} });
  });

  it('resolves an empty membership set (never calling db.organizations) for an id-less caller', async () => {
    const spy = vi.fn().mockResolvedValue([]);
    const findMembershipOrgIds = vi.fn().mockResolvedValue(['unreachable']);
    await getDynamicDataLakeAccess({
      db: { dataLakes: { findActiveByUserTagsAndEntitlements: spy } as never, organizations: { findMembershipOrgIds } },
      user: { tags: [] },
    });
    // An id-less caller is a member of nothing - the resolver must not even ask, since there is
    // no id to resolve membership for.
    expect(findMembershipOrgIds).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith([], [], [], undefined, { grantedLakeIds: [], orgGrantedLakes: {} });
  });

  it('string-coerces an ObjectId-like id before resolving membership and querying', async () => {
    const spy = vi.fn().mockResolvedValue([]);
    const findMembershipOrgIds = vi.fn().mockResolvedValue([]);
    // Simulates a hydrated user doc: id arrives as an ObjectId-like value (exposes toString).
    await getDynamicDataLakeAccess({
      db: { dataLakes: { findActiveByUserTagsAndEntitlements: spy } as never, organizations: { findMembershipOrgIds } },
      user: { id: { toString: () => 'user-oid' }, tags: [] },
    });
    expect(findMembershipOrgIds).toHaveBeenCalledWith('user-oid');
    expect(spy).toHaveBeenCalledWith([], [], [], 'user-oid', { grantedLakeIds: [], orgGrantedLakes: {} });
  });

  it('passes the resolved membership set through to the collection query unchanged', async () => {
    const spy = vi.fn().mockResolvedValue([]);
    // The resolver does no normalization of its own on this set - findMembershipOrgIds is the
    // authority, and already returns normalized strings (#1674).
    const findMembershipOrgIds = vi.fn().mockResolvedValue(['org-hex', 'org-hex-2']);
    await getDynamicDataLakeAccess({
      db: { dataLakes: { findActiveByUserTagsAndEntitlements: spy } as never, organizations: { findMembershipOrgIds } },
      user: { id: 'u1', tags: [] },
    });
    expect(spy).toHaveBeenCalledWith([], [], ['org-hex', 'org-hex-2'], 'u1', {
      grantedLakeIds: [],
      orgGrantedLakes: {},
    });
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
      db: { dataLakes: failing as never, organizations: { findMembershipOrgIds: vi.fn().mockResolvedValue([]) } },
      user: { tags: ['Opti'] },
      entitlementKeys: [],
      logger: { warn } as never,
    });

    expect(warn).toHaveBeenCalled();
    // Degrades to the static registry rather than throwing - narrowing, never widening.
    expect(res.scopedTagPrefixes).toEqual([]);
    // The warn is dropped whenever no logger is passed, so the flag is the only durable signal.
    // Consumers that would otherwise read an absent tag as proof of unreachability key on this.
    expect(res.lakeViewComplete).toBe(false);
  });

  it('propagates a membership-lookup failure instead of degrading to member-of-nothing', async () => {
    // Pins the N1 fail-closed claim: unlike the dataLakes read above (caught, degrades to
    // static-only), a failure resolving organizationIds is NOT caught by this resolver.
    const findMembershipOrgIds = vi.fn().mockRejectedValue(new Error('mongo down'));
    await expect(
      getDynamicDataLakeAccess({
        db: {
          dataLakes: { findActiveByUserTagsAndEntitlements: vi.fn().mockResolvedValue([]) } as never,
          organizations: { findMembershipOrgIds },
        },
        user: { id: 'u1', tags: [] },
      })
    ).rejects.toThrow('mongo down');
  });

  it('throws a legible error when db.organizations.findMembershipOrgIds is not wired', async () => {
    await expect(
      getDynamicDataLakeAccess({
        db: {
          dataLakes: { findActiveByUserTagsAndEntitlements: vi.fn().mockResolvedValue([]) } as never,
          organizations: {} as never,
        },
        user: { id: 'u1', tags: [] },
      })
    ).rejects.toThrow(/findMembershipOrgIds/);
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

    const res = await getDynamicDataLakeAccess(ctx([orgLake], { user: { id: 'owner', tags: [] } }, ['orgA']));

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

// #2243: the membership arms a retrieval query should carry - one per DYNAMIC lake, none for a
// registry lake (no creator to anchor a prefix arm to).
/**
 * Link 1 of the count/browse parity chain (#2265). The count surface passes
 * `ResolvedLakeAccess.membership` through verbatim (pinned in knowledgeBaseCount/index.test.ts) and
 * the single-lake browse builds `registryMembershipScope(lake)` (pinned in
 * apps/client/pages/api/data-lakes/[id]/__tests__/registryScopeParity.test.ts). What closes the
 * chain is this: the scope the RESOLVER attaches to a registry lake is that same function's output,
 * not a second construction that merely agrees.
 *
 * Asserted against `registryMembershipScope` rather than a literal on purpose - a literal here
 * would be the third independent copy of the predicate, which is the drift this issue removed.
 */
describe('registry lakes carry the shared registry membership scope', () => {
  const optiConfig = DATA_LAKES.find(dl => dl.id === 'opti-knowledge')!;

  it('attaches registryMembershipScope, byte for byte, to a resolved registry lake', async () => {
    const res = await getDynamicDataLakeAccess({
      db: { organizations: { findMembershipOrgIds: vi.fn().mockResolvedValue([]) } },
      user: { tags: ['Opti'] },
    });

    const opti = res.lakes.find(l => l.datalakeTag === optiConfig.datalakeTag)!;
    expect(opti.source).toBe('registry');
    expect(opti.membership).toEqual(registryMembershipScope(optiConfig));
  });

  it('gives it kind "registry", so the multi-lake fan-outs still drop its unanchored prefix arm', async () => {
    const res = await getDynamicDataLakeAccess({
      db: { organizations: { findMembershipOrgIds: vi.fn().mockResolvedValue([]) } },
      user: { tags: ['Opti'] },
    });

    // The guard that replaced "membership is absent for registry lakes": presence proves nothing
    // now, the discriminant is the whole check.
    expect(res.lakes.every(l => l.membership.kind === 'registry')).toBe(true);
    expect(lakeMembershipsFrom(res.lakes)).toEqual([]);
  });

  it('keeps a DB lake creator-anchored, so the two kinds are not collapsed', async () => {
    const res = await getDynamicDataLakeAccess(
      ctx([dbLake({ id: 'acme', createdByUserId: 'creator-1', isPublic: true })])
    );

    const acme = res.lakes.find(l => l.datalakeTag === 'datalake:acme')!;
    expect(acme.membership).toEqual({
      kind: 'owned',
      datalakeTag: 'datalake:acme',
      fileTagPrefix: 'acme:',
      creatorUserId: 'creator-1',
    });
    expect(lakeMembershipsFrom(res.lakes)).toEqual([acme.membership]);
  });
});

describe('lakeMembershipsFrom', () => {
  const dynamicLake = (id: string, creatorUserId: string): ResolvedLakeAccess => ({
    id,
    name: id,
    slug: id,
    datalakeTag: `datalake:${id}`,
    fileTagPrefix: `${id}:`,
    membership: { kind: 'owned', datalakeTag: `datalake:${id}`, fileTagPrefix: `${id}:`, creatorUserId },
    source: 'dynamic',
  });
  // A registry lake carries a scope too, an UNANCHORED one - so what this helper drops is decided
  // by `kind`, not by the field being absent. Fixtures that omit it can no longer express the case.
  const registryLake = (id: string): ResolvedLakeAccess => ({
    id,
    name: id,
    slug: id,
    datalakeTag: `datalake:${id}`,
    fileTagPrefix: `${id}:`,
    membership: { kind: 'registry', datalakeTag: `datalake:${id}`, fileTagPrefix: `${id}:` },
    source: 'registry',
  });

  it('keeps dynamic lakes in order and drops registry ones', () => {
    const lakes = [registryLake('opti'), dynamicLake('acme', 'creator-1'), dynamicLake('globex', 'creator-2')];

    expect(lakeMembershipsFrom(lakes)).toEqual([
      dynamicLake('acme', 'creator-1').membership,
      dynamicLake('globex', 'creator-2').membership,
    ]);
  });

  it('returns [] for an all-registry lake set', () => {
    expect(lakeMembershipsFrom([registryLake('opti'), registryLake('house')])).toEqual([]);
  });

  it('returns [] for an empty lake set', () => {
    expect(lakeMembershipsFrom([])).toEqual([]);
  });
});

/**
 * The grant rung on the RETRIEVAL path. Browse has honoured persisted grants since #1668; this is
 * the arm that stops a grant-reached lake being browsable but not groundable - the live case being
 * a transferred owner, since transferLakeOwnership moves ownership through grant rows and leaves
 * `createdByUserId` on the original creator.
 *
 * The repo mock returns whatever the fixture lists, as everywhere else in this file: the datastore
 * arm itself is pinned in DataLakeModel.test.ts, and its agreement with the browse query in
 * packages/database/src/models/ai/DataLakeModel.grantScopeAgreement.test.ts. What is asserted here
 * is which grants the resolver ASKS for (the includeReaders split) and what it does with the rows
 * that come back.
 */
describe('getDynamicDataLakeAccess - the persisted access-grant rung', () => {
  const grantRow = (dataLakeId: string, role: 'owner' | 'curator' | 'reader', principalId = 'grantee') =>
    ({ dataLakeId, principalType: 'user', principalId, role }) as never;

  // A lake someone else created, whose gate the caller does not hold: unreachable except by grant.
  const theirGatedLake = dbLake({
    id: 'theirs',
    createdByUserId: 'original-creator',
    requiredUserTag: 'TagIDoNotHold',
  });

  const orgGrantRow = (dataLakeId: string, orgId: string, role: 'owner' | 'curator' | 'reader' = 'reader') =>
    ({ dataLakeId, principalType: 'organization', principalId: orgId, role }) as never;

  const grantCtx = (
    lakes: IDataLakeDocument[],
    rows: unknown[],
    over: { enforce?: boolean | undefined; organizationIds?: string[]; orgRows?: Record<string, unknown[]> } = {}
  ): DataLakeAccessContext => ({
    db: {
      dataLakes: { findActiveByUserTagsAndEntitlements: vi.fn().mockResolvedValue(lakes) } as never,
      organizations: { findMembershipOrgIds: vi.fn().mockResolvedValue(over.organizationIds ?? []) },
      // Dispatches on the principal it was asked about. A mock that answers every query with the
      // USER fixture would hand user-shaped rows back to the `('organization', orgId)` lookup, so an
      // org-reach test would pass on a row production cannot mint.
      dataLakeAccessGrants: {
        listByPrincipal: vi.fn(async (type: string, id: string) =>
          type === 'user' ? rows : (over.orgRows?.[id] ?? [])
        ),
      } as never,
      ...(over.enforce === undefined
        ? {}
        : { adminSettings: { getSettingsValue: vi.fn().mockResolvedValue(over.enforce) } as never }),
    },
    user: { id: 'grantee', tags: [] },
  });

  it('grounds a transferred OWNER on a lake they did not create', async () => {
    // The gap this closes: browse/open already admit this caller via grantedLakeReachFor, retrieval
    // did not, so a transferred owner could read the lake page and not ground on it.
    const ctxWithGrant = grantCtx([theirGatedLake], [grantRow('theirs', 'owner')]);

    const res = await getDynamicDataLakeAccess(ctxWithGrant);

    expect(res.dataLakeTags).toEqual(['datalake:theirs']);
    expect(res.scopedTagPrefixes).toEqual(['theirs:']);
    // A DB lake's prefix stays SCOPED - a grant is not a promotion into the ownership bypass.
    expect(res.dataLakeTagPrefixes).toEqual([]);
    // The id reaches the datastore pre-filter too, not only the in-memory restoration.
    expect(ctxWithGrant.db.dataLakes!.findActiveByUserTagsAndEntitlements).toHaveBeenCalledWith([], [], [], 'grantee', {
      grantedLakeIds: ['theirs'],
      orgGrantedLakes: {},
    });
  });

  it('grounds a CURATOR grant ungated, matching grantedLakeReachFor', async () => {
    const res = await getDynamicDataLakeAccess(grantCtx([theirGatedLake], [grantRow('theirs', 'curator')]));

    expect(res.dataLakeTags).toEqual(['datalake:theirs']);
  });

  it('holds a READER grant back until the cutover is enforced', async () => {
    // No settings adapter and an explicit `false` are the same answer: report-only, so a reader
    // grant would list a lake whose gate then 404s on open. Under enforce it resolves.
    const unwired = await getDynamicDataLakeAccess(grantCtx([theirGatedLake], [grantRow('theirs', 'reader')]));
    expect(unwired.dataLakeTags).toEqual([]);

    const off = await getDynamicDataLakeAccess(
      grantCtx([theirGatedLake], [grantRow('theirs', 'reader')], { enforce: false })
    );
    expect(off.dataLakeTags).toEqual([]);

    const on = await getDynamicDataLakeAccess(
      grantCtx([theirGatedLake], [grantRow('theirs', 'reader')], { enforce: true })
    );
    expect(on.dataLakeTags).toEqual(['datalake:theirs']);
  });

  it('hands the datastore an org grant KEYED BY THE ISSUING ORG, for a caller who belongs to two', async () => {
    // The wire round 1's containment fix rests on. The datastore ANDs each org's ids with
    // `organizationId: <that org>` (DataLakeModel `orgGrantArms`), which is the only place the
    // lake's own org is known - so the issuer has to survive the trip. Flattening this map into
    // `grantedLakeIds` routes it into the unconditional USER arm instead, and an orgA grant then
    // lifts an orgB lake's gate for anyone who belongs to both. The DENY itself is proven where the
    // comparison happens (DataLakeModel.test.ts); what is asserted here is that the question
    // reaches it intact.
    const theirOrgALake = dbLake({
      id: 'theirs-in-a',
      organizationId: 'orgA',
      createdByUserId: 'original-creator',
      requiredUserTag: 'TagIDoNotHold',
    });
    const ctxWithOrgGrant = grantCtx([theirOrgALake], [], {
      enforce: true,
      organizationIds: ['orgA', 'orgB'],
      orgRows: { orgA: [orgGrantRow('theirs-in-a', 'orgA')] },
    });

    const res = await getDynamicDataLakeAccess(ctxWithOrgGrant);

    expect(ctxWithOrgGrant.db.dataLakes!.findActiveByUserTagsAndEntitlements).toHaveBeenCalledWith(
      [],
      [],
      ['orgA', 'orgB'],
      'grantee',
      { grantedLakeIds: [], orgGrantedLakes: { orgA: ['theirs-in-a'] } }
    );
    // And the in-memory pass restores it past its own gate, as the id arm's counterpart.
    expect(res.dataLakeTags).toEqual(['datalake:theirs-in-a']);
  });

  it('never asks about an org the caller is not a member of', async () => {
    // The org half keys off MEMBERSHIP: a grant issued by an org the caller has left reaches
    // nothing, and no query is spent on it.
    const ctxNonMember = grantCtx([theirGatedLake], [], {
      enforce: true,
      organizationIds: ['orgB'],
      orgRows: { orgA: [orgGrantRow('theirs', 'orgA')] },
    });

    const res = await getDynamicDataLakeAccess(ctxNonMember);

    expect(res.dataLakeTags).toEqual([]);
    expect(ctxNonMember.db.dataLakes!.findActiveByUserTagsAndEntitlements).toHaveBeenCalledWith(
      [],
      [],
      ['orgB'],
      'grantee',
      { grantedLakeIds: [], orgGrantedLakes: {} }
    );
  });

  it('keeps a grant-reached lake creator-anchored, not caller-anchored', async () => {
    // The whole reason this is a small change: the membership predicate is anchored to the lake's
    // CREATOR, so a grantee retrieves the same files the owner does without any prefix rewrite.
    const res = await getDynamicDataLakeAccess(grantCtx([theirGatedLake], [grantRow('theirs', 'owner')]));

    const lake = res.lakes.find(l => l.id === 'theirs')!;
    expect(lake.membership).toEqual({
      kind: 'owned',
      datalakeTag: 'datalake:theirs',
      fileTagPrefix: 'theirs:',
      creatorUserId: 'original-creator',
    });
  });

  it('does not restore a grant-reached lake whose meta-tag is malformed', async () => {
    // The well-formedness guard the owner restoration carries: a privileged path may not re-admit
    // a row whose tag is not the one its own slug would mint.
    const malformed = dbLake({
      id: 'bad',
      createdByUserId: 'original-creator',
      datalakeTag: 'datalake:not-my-slug',
      requiredUserTag: 'TagIDoNotHold',
    });

    const res = await getDynamicDataLakeAccess(grantCtx([malformed], [grantRow('bad', 'owner')]));

    expect(res.dataLakeTags).toEqual([]);
  });

  it('restores a granted lake once, not twice, when the caller also created it', async () => {
    const own = dbLake({ id: 'theirs', createdByUserId: 'grantee', requiredUserTag: 'TagIDoNotHold' });

    const res = await getDynamicDataLakeAccess(grantCtx([own], [grantRow('theirs', 'owner')]));

    expect(res.dataLakeTags).toEqual(['datalake:theirs']);
    expect(res.scopedTagPrefixes).toEqual(['theirs:']);
  });

  it('ignores a grant for a lake the query did not return', async () => {
    // A stale grant naming an archived/deleted lake must not conjure it into the resolved set.
    const res = await getDynamicDataLakeAccess(grantCtx([], [grantRow('long-gone', 'owner')]));

    expect(res.lakes).toEqual([]);
  });

  it('changes nothing when no grant adapter is wired', async () => {
    const res = await getDynamicDataLakeAccess(ctx([theirGatedLake], { user: { id: 'grantee', tags: [] } }));

    expect(res.dataLakeTags).toEqual([]);
    expect(res.lakeViewComplete).toBe(true);
  });

  it('fails closed when the grant lookup throws, without losing the rest of the view', async () => {
    // A grant read that cannot be answered must narrow retrieval, never throw a chat turn away or
    // widen it - the same direction every other degrade in this resolver takes.
    const open = dbLake({ id: 'open', createdByUserId: 'original-creator', isPublic: true });
    const logger = { warn: vi.fn() };
    const res = await getDynamicDataLakeAccess({
      db: {
        dataLakes: {
          findActiveByUserTagsAndEntitlements: vi.fn().mockResolvedValue([open, theirGatedLake]),
        } as never,
        organizations: { findMembershipOrgIds: vi.fn().mockResolvedValue([]) },
        dataLakeAccessGrants: { listByPrincipal: vi.fn().mockRejectedValue(new Error('grants down')) } as never,
      },
      user: { id: 'grantee', tags: [] },
      logger: logger as never,
    });

    expect(res.dataLakeTags).toEqual(['datalake:open']);
    // Narrowed, and it SAYS so: a consumer must not read the absent grant arm as proof of
    // unreachability. The rest of the view survives.
    expect(res.lakeViewComplete).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/access-grant lookup failed/), expect.anything());
  });

  it('never asks for grants for an id-less caller', async () => {
    const listByPrincipal = vi.fn().mockResolvedValue([grantRow('theirs', 'owner')]);
    const res = await getDynamicDataLakeAccess({
      db: {
        dataLakes: { findActiveByUserTagsAndEntitlements: vi.fn().mockResolvedValue([theirGatedLake]) } as never,
        organizations: { findMembershipOrgIds: vi.fn().mockResolvedValue([]) },
        dataLakeAccessGrants: { listByPrincipal } as never,
      },
      user: { tags: [] },
    });

    expect(listByPrincipal).not.toHaveBeenCalled();
    expect(res.dataLakeTags).toEqual([]);
  });

  /**
   * This resolver runs per TOOL CALL - three tool-layer entry points forward the same `ToolContext`
   * (resolveSessionLakeAccess, resolveAttachmentLakeAccess, knowledgeBaseRetrieve) - so a turn using
   * two knowledge tools re-issued all three of its reads. Both calls here share ONE context object,
   * which is what those entry points do.
   */
  describe('per-turn read collapse', () => {
    it('issues one grant, membership and flag read for two resolutions in the same turn', async () => {
      const ctx = grantCtx([theirGatedLake], [grantRow('theirs', 'owner')], { enforce: true });

      const first = await getDynamicDataLakeAccess(ctx);
      const second = await getDynamicDataLakeAccess(ctx);

      expect(second.dataLakeTags).toEqual(first.dataLakeTags);
      expect(second.dataLakeTags).toEqual(['datalake:theirs']);
      expect(ctx.db.dataLakeAccessGrants?.listByPrincipal).toHaveBeenCalledTimes(1);
      expect(ctx.db.organizations.findMembershipOrgIds).toHaveBeenCalledTimes(1);
      expect(ctx.db.adminSettings?.getSettingsValue).toHaveBeenCalledTimes(1);
    });

    it('does NOT share any of the three between two turns', async () => {
      // Two contexts are two requests. A hit across them would keep honoring a grant, a membership
      // or an enforcement setting that changed a request ago.
      await getDynamicDataLakeAccess(grantCtx([theirGatedLake], [grantRow('theirs', 'owner')], { enforce: true }));
      const second = grantCtx([theirGatedLake], [grantRow('theirs', 'owner')], { enforce: true });
      await getDynamicDataLakeAccess(second);

      expect(second.db.dataLakeAccessGrants?.listByPrincipal).toHaveBeenCalledTimes(1);
      expect(second.db.organizations.findMembershipOrgIds).toHaveBeenCalledTimes(1);
      expect(second.db.adminSettings?.getSettingsValue).toHaveBeenCalledTimes(1);
    });

    it('re-reads the grants after a failure instead of reporting the view complete', async () => {
      // The fail-closed contract this resolver already had: a failed grant read narrows the view AND
      // says so via lakeViewComplete. A cached rejection would leave the second call narrowed while
      // silently reporting complete.
      const ctx = grantCtx([theirGatedLake], [grantRow('theirs', 'owner')], { enforce: true });
      (ctx.db.dataLakeAccessGrants?.listByPrincipal as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('grants down')
      );

      const failed = await getDynamicDataLakeAccess(ctx);
      expect(failed.dataLakeTags).toEqual([]);
      expect(failed.lakeViewComplete).toBe(false);

      const recovered = await getDynamicDataLakeAccess(ctx);
      expect(recovered.dataLakeTags).toEqual(['datalake:theirs']);
      expect(recovered.lakeViewComplete).toBe(true);
      expect(ctx.db.dataLakeAccessGrants?.listByPrincipal).toHaveBeenCalledTimes(2);
    });
  });
});

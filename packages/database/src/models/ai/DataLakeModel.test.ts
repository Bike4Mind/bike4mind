import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import type { AccessContext, IDataLake } from '@bike4mind/common';
import { lakeMatchesAccess, normalizeEntitlementKey } from '@bike4mind/common';
import { dataLakeRepository, dataLakeBatchRepository, DataLakeModel } from './DataLakeModel';
import { setupMongoTest } from '../../__test__/utils';

const baseLake = (overrides: Partial<IDataLake> & Pick<IDataLake, 'slug'>): Omit<IDataLake, 'id'> =>
  ({
    name: overrides.slug,
    fileTagPrefix: `${overrides.slug}:`,
    datalakeTag: `datalake:${overrides.slug}`,
    createdByUserId: 'admin',
    status: 'active',
    ...overrides,
  }) as Omit<IDataLake, 'id'>;

describe('DataLakeRepository.findActiveByUserTagsAndEntitlements', () => {
  setupMongoTest();

  it('returns a both-fields (medlib) lake for a comp-tag holder AND a tag-less subscriber', async () => {
    await dataLakeRepository.create(
      baseLake({ slug: 'medlib', requiredUserTag: 'medlib', requiredEntitlement: 'medlib:pro' })
    );

    const viaTag = await dataLakeRepository.findActiveByUserTagsAndEntitlements(['medlib'], []);
    expect(viaTag.map(l => l.slug)).toEqual(['medlib']);

    const viaKey = await dataLakeRepository.findActiveByUserTagsAndEntitlements([], ['medlib:pro']);
    expect(viaKey.map(l => l.slug)).toEqual(['medlib']);

    const neither = await dataLakeRepository.findActiveByUserTagsAndEntitlements(['unrelated'], ['unrelated:key']);
    expect(neither).toEqual([]);
  });

  it('does NOT return an entitlement-only lake to a user lacking the key (not public)', async () => {
    await dataLakeRepository.create(baseLake({ slug: 'ent', requiredEntitlement: 'product:pro' }));

    expect(await dataLakeRepository.findActiveByUserTagsAndEntitlements(['anyone'], [])).toEqual([]);
    const granted = await dataLakeRepository.findActiveByUserTagsAndEntitlements([], ['product:pro']);
    expect(granted.map(l => l.slug)).toEqual(['ent']);
  });

  it('Private-by-default: a gateless, org-less lake is owner-only (not world-readable)', async () => {
    await dataLakeRepository.create(baseLake({ slug: 'personal', createdByUserId: 'alice' }));
    await dataLakeRepository.create(baseLake({ slug: 'acme', requiredUserTag: 'Opti' }));

    // A non-owner with no tags sees NEITHER the private lake nor the gated one.
    const stranger = await dataLakeRepository.findActiveByUserTagsAndEntitlements([], [], undefined, 'bob');
    expect(stranger).toEqual([]);

    // The owner retrieves their own private lake (owner bypass).
    const owner = await dataLakeRepository.findActiveByUserTagsAndEntitlements([], [], undefined, 'alice');
    expect(owner.map(l => l.slug)).toEqual(['personal']);

    // A tag holder gets the gated lake - but still NOT someone else's private lake.
    const optiUser = await dataLakeRepository.findActiveByUserTagsAndEntitlements(['Opti'], [], undefined, 'bob');
    expect(optiUser.map(l => l.slug)).toEqual(['acme']);
  });

  it('does not throw on empty entitlementKeys; a gateless lake stays owner-only', async () => {
    await dataLakeRepository.create(baseLake({ slug: 'personal', createdByUserId: 'alice' }));
    await dataLakeRepository.create(baseLake({ slug: 'medlib', requiredEntitlement: 'medlib:pro' }));

    // Non-owner with no tags/keys -> nothing (and no throw on empty keys).
    expect(await dataLakeRepository.findActiveByUserTagsAndEntitlements([], [], undefined, 'bob')).toEqual([]);
    // Owner sees their own gateless lake.
    const owner = await dataLakeRepository.findActiveByUserTagsAndEntitlements([], [], undefined, 'alice');
    expect(owner.map(l => l.slug)).toEqual(['personal']);
  });

  it('normalizes requiredEntitlement at write time (schema setter) so mixed-case input still matches', async () => {
    // Store a MIXED-CASE value via a direct repo.create: the schema setter must persist it
    // lowercase, so the case-sensitive $in query still matches.
    const created = await dataLakeRepository.create(baseLake({ slug: 'medlib', requiredEntitlement: 'Medlib:Pro' }));
    expect(created.requiredEntitlement).toBe('medlib:pro'); // write-time normalization guaranteed at the schema layer
    // Query side also normalizes the key, so a messy key resolves to the stored value.
    const res = await dataLakeRepository.findActiveByUserTagsAndEntitlements([], ['  MedLib:PRO  ']);
    expect(res.map(l => l.slug)).toEqual(['medlib']);
  });

  it('org-scopes the retrieval path: org lakes resolve only in-org; org-less gated lakes stay cross-org', async () => {
    await dataLakeRepository.create(baseLake({ slug: 'acme', organizationId: 'orgA' })); // gateless ORG lake
    await dataLakeRepository.create(baseLake({ slug: 'shared', requiredUserTag: 'Opti' })); // org-less, gated (curated-style)

    // Org-A member holding the tag: gets the gateless org lake (org IS its grant) + the cross-org gated lake.
    const inOrgWithTag = await dataLakeRepository.findActiveByUserTagsAndEntitlements(['Opti'], [], 'orgA', 'u1');
    expect(inOrgWithTag.map(l => l.slug).sort()).toEqual(['acme', 'shared']);

    // Org-A member WITHOUT the tag: still gets the gateless org lake (org membership), not the gated one.
    const inOrgNoTag = await dataLakeRepository.findActiveByUserTagsAndEntitlements([], [], 'orgA', 'u1');
    expect(inOrgNoTag.map(l => l.slug)).toEqual(['acme']);

    // Org-B member with the tag: gets the cross-org gated lake, NOT org-A's lake.
    const orgBWithTag = await dataLakeRepository.findActiveByUserTagsAndEntitlements(['Opti'], [], 'orgB', 'u2');
    expect(orgBWithTag.map(l => l.slug)).toEqual(['shared']);
  });

  it('org is a hard prerequisite combined with the tag gate (needs BOTH matching org AND tag)', async () => {
    await dataLakeRepository.create(baseLake({ slug: 'gated', organizationId: 'orgA', requiredUserTag: 'team' }));

    // Right org, missing tag -> excluded.
    expect(await dataLakeRepository.findActiveByUserTagsAndEntitlements([], [], 'orgA')).toEqual([]);
    // Right org + tag -> included.
    const ok = await dataLakeRepository.findActiveByUserTagsAndEntitlements(['team'], [], 'orgA');
    expect(ok.map(l => l.slug)).toEqual(['gated']);
    // Wrong org even with the tag -> excluded (org is not a flat OR with the tag).
    expect(await dataLakeRepository.findActiveByUserTagsAndEntitlements(['team'], [], 'orgB')).toEqual([]);
  });

  it('Public: an isPublic lake is retrievable by any user, cross-org, without owner/tag/key', async () => {
    await dataLakeRepository.create(baseLake({ slug: 'pub', isPublic: true, createdByUserId: 'alice' }));
    await dataLakeRepository.create(baseLake({ slug: 'personal', createdByUserId: 'alice' })); // private control

    // A stranger in a different org retrieves the public lake but NOT the private one.
    const stranger = await dataLakeRepository.findActiveByUserTagsAndEntitlements([], [], 'orgB', 'bob');
    expect(stranger.map(l => l.slug)).toEqual(['pub']);
    // A tag/key-less stranger with no org still gets it.
    const orgless = await dataLakeRepository.findActiveByUserTagsAndEntitlements([], [], undefined, 'bob');
    expect(orgless.map(l => l.slug)).toEqual(['pub']);
  });

  it('Public + a (post-publish) gate still enforces the gate in retrieval — defense in depth', async () => {
    await dataLakeRepository.create(baseLake({ slug: 'pubgated', isPublic: true, requiredEntitlement: 'product:pro' }));

    // No key -> excluded even though isPublic is set (the gate holds).
    expect(await dataLakeRepository.findActiveByUserTagsAndEntitlements([], [], 'orgB', 'bob')).toEqual([]);
    // Key held -> retrievable cross-org (public bypasses the org prerequisite).
    const withKey = await dataLakeRepository.findActiveByUserTagsAndEntitlements([], ['product:pro'], 'orgB', 'bob');
    expect(withKey.map(l => l.slug)).toEqual(['pubgated']);
  });
});

describe('DataLakeRepository.findAccessible — Private-by-default (HTTP/management path)', () => {
  setupMongoTest();

  const ctx = (
    over: Partial<{ userId: string; isAdmin: boolean; userTags: string[]; organizationId?: string }> = {}
  ) => ({
    userId: 'someone',
    isAdmin: false,
    userTags: [] as string[],
    organizationId: undefined as string | undefined,
    ...over,
  });

  it('a gateless, org-less lake is owner-only — strangers do not see it, the owner and admins do', async () => {
    await dataLakeRepository.create(baseLake({ slug: 'personal', createdByUserId: 'alice' }));

    expect(await dataLakeRepository.findAccessible(ctx({ userId: 'bob' }))).toEqual([]);
    expect((await dataLakeRepository.findAccessible(ctx({ userId: 'alice' }))).map(l => l.slug)).toEqual(['personal']);
    // Admin bypass still sees everything.
    expect((await dataLakeRepository.findAccessible(ctx({ userId: 'bob', isAdmin: true }))).map(l => l.slug)).toEqual([
      'personal',
    ]);
  });

  it('a gateless ORG lake is visible to org members; a tag lake to tag holders; cross-org/non-holders excluded', async () => {
    await dataLakeRepository.create(baseLake({ slug: 'acme', organizationId: 'orgA' }));
    await dataLakeRepository.create(baseLake({ slug: 'shared', requiredUserTag: 'Opti' }));

    // Org-A member (no tag): sees the org lake, not the gated one, not anyone's private lake.
    expect(
      (await dataLakeRepository.findAccessible(ctx({ userId: 'u1', organizationId: 'orgA' }))).map(l => l.slug)
    ).toEqual(['acme']);
    // Org-B member holding the tag: the cross-org gated lake only - never org-A's lake.
    expect(
      (await dataLakeRepository.findAccessible(ctx({ userId: 'u2', organizationId: 'orgB', userTags: ['Opti'] }))).map(
        l => l.slug
      )
    ).toEqual(['shared']);
  });

  it('Public: an isPublic lake is listed for a stranger in another org; a private one is not', async () => {
    await dataLakeRepository.create(baseLake({ slug: 'pub', isPublic: true, createdByUserId: 'alice' }));
    await dataLakeRepository.create(baseLake({ slug: 'personal', createdByUserId: 'alice' }));

    // A non-owner in a different org gets the public lake but never the org-less private one.
    const res = await dataLakeRepository.findAccessible(ctx({ userId: 'bob', organizationId: 'orgB' }));
    expect(res.map(l => l.slug)).toEqual(['pub']);
  });

  it('management view (includePublic:false) drops the public arm: a stranger is excluded, the owner still sees their own', async () => {
    await dataLakeRepository.create(
      baseLake({ slug: 'pubarch', isPublic: true, createdByUserId: 'alice', status: 'archived' })
    );

    // Browse/read view (default includePublic) would surface it to a stranger...
    expect(
      (await dataLakeRepository.findAccessible(ctx({ userId: 'bob' }), { statuses: ['archived'] })).map(l => l.slug)
    ).toEqual(['pubarch']);
    // ...but the management view drops the public arm, so a stranger sees nothing.
    expect(
      await dataLakeRepository.findAccessible(ctx({ userId: 'bob' }), { statuses: ['archived'], includePublic: false })
    ).toEqual([]);
    // The owner still sees their own archived public lake via the owner arm.
    expect(
      (
        await dataLakeRepository.findAccessible(ctx({ userId: 'alice' }), {
          statuses: ['archived'],
          includePublic: false,
        })
      ).map(l => l.slug)
    ).toEqual(['pubarch']);
  });
});

describe('DataLakeRepository.findAccessible — management gate (entitlement-aware any-of)', () => {
  setupMongoTest();

  const ctx = (overrides: Partial<AccessContext> = {}): AccessContext => ({
    userId: 'someone-else',
    isAdmin: false,
    userTags: [],
    organizationId: undefined,
    ...overrides,
  });

  it('does NOT leak an entitlement-only lake to a non-owner lacking the key (the both-blank restructure)', async () => {
    // Before the fix, the blank `requiredUserTag` arm returned this lake to EVERYONE. The
    // restructured requirement arm requires BOTH fields blank for the "no restriction" case,
    // so an entitlement-only lake is gated by the key.
    await dataLakeRepository.create(baseLake({ slug: 'ent', requiredEntitlement: 'product:pro' }));

    expect(await dataLakeRepository.findAccessible(ctx({ entitlementKeys: [] }))).toEqual([]);
    expect(await dataLakeRepository.findAccessible(ctx({ entitlementKeys: ['other:pro'] }))).toEqual([]);
    const granted = await dataLakeRepository.findAccessible(ctx({ entitlementKeys: ['product:pro'] }));
    expect(granted.map(l => l.slug)).toEqual(['ent']);
  });

  it('returns a both-fields lake via EITHER the tag OR the entitlement key', async () => {
    await dataLakeRepository.create(
      baseLake({ slug: 'medlib', requiredUserTag: 'medlib', requiredEntitlement: 'medlib:pro' })
    );
    expect((await dataLakeRepository.findAccessible(ctx({ userTags: ['medlib'] }))).map(l => l.slug)).toEqual([
      'medlib',
    ]);
    expect(
      (await dataLakeRepository.findAccessible(ctx({ entitlementKeys: ['medlib:pro'] }))).map(l => l.slug)
    ).toEqual(['medlib']);
    expect(await dataLakeRepository.findAccessible(ctx())).toEqual([]);
  });

  it('owner bypass: the creator sees their own lakes without any tag/key — a private one and a gated one alike', async () => {
    // Private-by-default: an org-less no-restriction lake ('myprivate') is owner-only, NOT
    // world-readable. The owner still sees it (and their gated lake) via the owner bypass.
    await dataLakeRepository.create(baseLake({ slug: 'myprivate', createdByUserId: 'someone-else' }));
    await dataLakeRepository.create(
      baseLake({ slug: 'mine', createdByUserId: 'someone-else', requiredEntitlement: 'product:pro' })
    );
    const res = await dataLakeRepository.findAccessible(ctx());
    expect(res.map(l => l.slug).sort()).toEqual(['mine', 'myprivate']); // both via owner bypass
  });

  it('admin sees all lakes regardless of tag/entitlement/org', async () => {
    await dataLakeRepository.create(baseLake({ slug: 'ent', requiredEntitlement: 'product:pro' }));
    await dataLakeRepository.create(baseLake({ slug: 'orglake', organizationId: 'orgZ', requiredUserTag: 'x' }));
    const res = await dataLakeRepository.findAccessible(ctx({ isAdmin: true }));
    expect(res.map(l => l.slug).sort()).toEqual(['ent', 'orglake']);
  });

  it('org is a hard prerequisite: an entitlement-holder in a DIFFERENT org is excluded', async () => {
    await dataLakeRepository.create(
      baseLake({ slug: 'orgent', organizationId: 'orgA', requiredEntitlement: 'product:pro' })
    );
    // Right org + key -> included.
    expect(
      (await dataLakeRepository.findAccessible(ctx({ organizationId: 'orgA', entitlementKeys: ['product:pro'] }))).map(
        l => l.slug
      )
    ).toEqual(['orgent']);
    // Wrong org even with the key -> excluded (org is not a flat OR with the requirement).
    expect(
      await dataLakeRepository.findAccessible(ctx({ organizationId: 'orgB', entitlementKeys: ['product:pro'] }))
    ).toEqual([]);
  });

  it('does not throw on empty entitlementKeys', async () => {
    // Use a tag-gated (non-private) lake the caller holds: private-by-default would hide an
    // org-less no-gate lake, so the empty-keys guard ($in: undefined) is exercised on a lake
    // that is actually visible.
    await dataLakeRepository.create(baseLake({ slug: 'tagged', requiredUserTag: 'team' }));
    await dataLakeRepository.create(baseLake({ slug: 'ent', requiredEntitlement: 'product:pro' }));
    const res = await dataLakeRepository.findAccessible(ctx({ userTags: ['team'], entitlementKeys: [] }));
    expect(res.map(l => l.slug)).toEqual(['tagged']);
  });

  it('DB ↔ in-memory parity: findAccessible agrees with private-by-default + public layered over lakeMatchesAccess', async () => {
    // Lock the management DB pre-filter to the same decision the in-memory logic makes for a
    // non-owner: (isPublic OR not-private) applied on top of the any-of predicate. lakeMatchesAccess
    // alone returns true for a no-requirement lake, so the private-by-default arm must be composed
    // in to mirror findAccessible's `notPrivate`, and the public arm to mirror `publicArm`.
    // 'gateless' is a gateless, org-less (private-by-default) lake despite the innocuous name.
    const fixtures = [
      baseLake({ slug: 'gateless' }),
      baseLake({ slug: 'tagonly', requiredUserTag: 'team' }),
      baseLake({ slug: 'entonly', requiredEntitlement: 'product:pro' }),
      baseLake({ slug: 'both', requiredUserTag: 'team', requiredEntitlement: 'product:pro' }),
      baseLake({ slug: 'publicopen', isPublic: true }),
      baseLake({ slug: 'publicgated', isPublic: true, requiredUserTag: 'team' }),
    ];
    for (const f of fixtures) await dataLakeRepository.create(f);

    // Org-less + no gate = private -> owner-only, so a non-owner never sees it (unless public).
    const isPrivate = (f: (typeof fixtures)[number]) =>
      !f.organizationId && !f.requiredUserTag && !f.requiredEntitlement;

    const cases: AccessContext[] = [
      ctx(),
      ctx({ userTags: ['team'] }),
      ctx({ entitlementKeys: ['product:pro'] }),
      ctx({ userTags: ['team'], entitlementKeys: ['product:pro'] }),
    ];
    for (const c of cases) {
      const fromDb = (await dataLakeRepository.findAccessible(c)).map(l => l.slug).sort();
      const normTags = c.userTags.map(t => t.toLowerCase());
      const normKeys = (c.entitlementKeys ?? []).map(normalizeEntitlementKey);
      // Non-owner mirror: the gate (lakeMatchesAccess) must pass, AND the lake must be reachable
      // either because it is public or because it is not private-by-default. (All fixtures are
      // org-less and ctxs org-less, so the org prerequisite is trivially satisfied here.)
      const fromMemory = fixtures
        .filter(f => lakeMatchesAccess(f, normTags, normKeys) && (!!f.isPublic || !isPrivate(f)))
        .map(f => f.slug)
        .sort();
      expect(fromDb, `ctx=${JSON.stringify(c)}`).toEqual(fromMemory);
    }
  });
});

describe('DataLakeRepository.findPublicLakes — public discover catalog', () => {
  setupMongoTest();

  // Seed the catalog once per test: a mix that exercises every exclusion rule.
  const seedMixed = async () => {
    await dataLakeRepository.create(baseLake({ slug: 'alpha', name: 'Alpha Lake', isPublic: true }));
    await dataLakeRepository.create(
      baseLake({ slug: 'beta', name: 'Beta Lake', description: 'about widgets', isPublic: true })
    );
    // Excluded: private (not public).
    await dataLakeRepository.create(baseLake({ slug: 'private-lake', createdByUserId: 'alice' }));
    // Excluded: public but gated after publishing (no longer open to everyone).
    await dataLakeRepository.create(baseLake({ slug: 'gated', isPublic: true, requiredUserTag: 'Opti' }));
    // Excluded: public but archived (browse is active-only).
    await dataLakeRepository.create(baseLake({ slug: 'archived-pub', isPublic: true, status: 'archived' }));
  };

  it('returns only active, public, gate-less lakes', async () => {
    await seedMixed();
    const { lakes, total } = await dataLakeRepository.findPublicLakes();
    expect(lakes.map(l => l.slug)).toEqual(['alpha', 'beta']); // sorted by name
    expect(total).toBe(2);
  });

  it('search matches name OR description, case-insensitively', async () => {
    await seedMixed();
    expect((await dataLakeRepository.findPublicLakes({ search: 'alpha' })).lakes.map(l => l.slug)).toEqual(['alpha']);
    // "widgets" only appears in beta's description.
    expect((await dataLakeRepository.findPublicLakes({ search: 'WIDGETS' })).lakes.map(l => l.slug)).toEqual(['beta']);
    expect((await dataLakeRepository.findPublicLakes({ search: 'lake' })).total).toBe(2);
  });

  it('paginates with limit/offset while total stays the full count', async () => {
    await seedMixed();
    const page1 = await dataLakeRepository.findPublicLakes({ limit: 1, offset: 0 });
    expect(page1.lakes.map(l => l.slug)).toEqual(['alpha']);
    expect(page1.total).toBe(2);
    const page2 = await dataLakeRepository.findPublicLakes({ limit: 1, offset: 1 });
    expect(page2.lakes.map(l => l.slug)).toEqual(['beta']);
    expect(page2.total).toBe(2);
  });

  it('paginates deterministically across same-named lakes (no dup/skip between pages)', async () => {
    // Same name on every lake -> name alone is not a total order; the _id tiebreaker is what
    // keeps skip/limit pages disjoint and complete.
    for (const slug of ['s1', 's2', 's3', 's4']) {
      await dataLakeRepository.create(baseLake({ slug, name: 'Same', isPublic: true }));
    }
    const seen: string[] = [];
    for (let offset = 0; offset < 4; offset += 2) {
      const { lakes } = await dataLakeRepository.findPublicLakes({ limit: 2, offset });
      seen.push(...lakes.map(l => l.slug));
    }
    // All four returned exactly once across the two pages - no overlap, nothing missed.
    expect(seen.length).toBe(4);
    expect(new Set(seen).size).toBe(4);
    expect([...seen].sort()).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('treats a regex-metacharacter search as a literal (no injection)', async () => {
    await dataLakeRepository.create(baseLake({ slug: 'dotstar', name: 'a.b', isPublic: true }));
    await dataLakeRepository.create(baseLake({ slug: 'plain', name: 'axb', isPublic: true }));
    // ".*" must match the literal "a.b" name, not act as a wildcard matching "axb".
    const { lakes } = await dataLakeRepository.findPublicLakes({ search: 'a.b' });
    expect(lakes.map(l => l.slug)).toEqual(['dotstar']);
  });
});

describe('DataLakeRepository — slug is unique per org', () => {
  setupMongoTest();

  // cleanupTestDB drops the whole DB before each test, so (re)build the model's indexes
  // (including the { organizationId, slug } unique index) before asserting the constraint.
  beforeEach(async () => {
    await DataLakeModel.ensureIndexes();
  });

  it('rejects a second lake with the same slug in the same org', async () => {
    // Distinct datalakeTags so the rejection is attributable to the (organizationId, slug)
    // index, not the separate unique index on datalakeTag.
    await dataLakeRepository.create(
      baseLake({ slug: 'dupe', organizationId: 'orgA', datalakeTag: 'datalake:orgA:dupe-1' })
    );
    await expect(
      dataLakeRepository.create(baseLake({ slug: 'dupe', organizationId: 'orgA', datalakeTag: 'datalake:orgA:dupe-2' }))
    ).rejects.toThrow();
  });

  it('allows the same slug in different orgs (unique per org, not global)', async () => {
    await dataLakeRepository.create(
      baseLake({ slug: 'shared', organizationId: 'orgA', datalakeTag: 'datalake:orgA:shared' })
    );
    await expect(
      dataLakeRepository.create(
        baseLake({ slug: 'shared', organizationId: 'orgB', datalakeTag: 'datalake:orgB:shared' })
      )
    ).resolves.toBeDefined();
  });
});

describe('DataLakeBatchRepository.markTerminalIfActive — completionReason', () => {
  setupMongoTest();

  const activeBatch = () => dataLakeBatchRepository.create({ dataLakeId: 'lake1', userId: 'u1' });

  it('persists completionReason when the reconciler forces a terminal transition', async () => {
    const batch = await activeBatch();
    const forced = await dataLakeBatchRepository.markTerminalIfActive(batch.id, 'completed_with_errors', 'reconciler');
    expect(forced?.status).toBe('completed_with_errors');
    expect(forced?.completionReason).toBe('reconciler');
  });

  it('leaves completionReason unset on a normal (reasonless) terminal transition', async () => {
    const batch = await activeBatch();
    const finalized = await dataLakeBatchRepository.markTerminalIfActive(batch.id, 'completed');
    expect(finalized?.status).toBe('completed');
    expect(finalized?.completionReason).toBeUndefined();
  });
});

describe('DataLakeBatchRepository.findStuck — global cross-user stale scan', () => {
  setupMongoTest();

  const CUTOFF = new Date('2021-01-01T00:00:00Z');

  // `timestamps: true` auto-stamps updatedAt to now on create, so backdate it directly
  // (timestamps:false) to seed a genuinely-stale doc.
  const seedBatch = async (status: string, updatedAt?: Date) => {
    const b = await dataLakeBatchRepository.create({ dataLakeId: 'lake1', userId: 'u1', status } as never);
    if (updatedAt) {
      await mongoose.models.DataLakeBatch.updateOne({ _id: b.id }, { $set: { updatedAt } }, { timestamps: false });
    }
    return b;
  };

  it('returns only stale non-terminal batches (excludes fresh and terminal)', async () => {
    const stale = await seedBatch('processing', new Date('2020-01-01T00:00:00Z'));
    await seedBatch('processing'); // fresh (updatedAt ~ now) -> excluded
    await seedBatch('completed', new Date('2020-01-01T00:00:00Z')); // stale but terminal -> excluded
    const stuck = await dataLakeBatchRepository.findStuck(CUTOFF);
    expect(stuck.map(b => b.id)).toEqual([stale.id]);
  });

  it('orders oldest-first and honors the limit', async () => {
    const older = await seedBatch('processing', new Date('2019-01-01T00:00:00Z'));
    const newer = await seedBatch('uploading', new Date('2020-06-01T00:00:00Z'));
    expect((await dataLakeBatchRepository.findStuck(CUTOFF)).map(b => b.id)).toEqual([older.id, newer.id]);
    expect((await dataLakeBatchRepository.findStuck(CUTOFF, 1)).map(b => b.id)).toEqual([older.id]);
  });
});

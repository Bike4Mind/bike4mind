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

  it('owner bypass reaches a GATED lake the creator does not personally satisfy', async () => {
    // The retrieval resolver relies on this arm to restore an owner's own gated lake after the
    // in-memory tag/entitlement filter drops it. Covered here at the datastore layer because the
    // resolver's own tests mock this repository, so they cannot prove the arm returns the row.
    await dataLakeRepository.create(
      baseLake({ slug: 'mine', createdByUserId: 'alice', requiredUserTag: 'TagAliceLacks' })
    );
    await dataLakeRepository.create(
      baseLake({ slug: 'theirs', createdByUserId: 'carol', requiredUserTag: 'TagAliceLacks' })
    );

    // Alice holds no tags and no keys, yet gets her own gated lake - and only hers.
    const owner = await dataLakeRepository.findActiveByUserTagsAndEntitlements([], [], undefined, 'alice');
    expect(owner.map(l => l.slug)).toEqual(['mine']);
    // A non-owner lacking the tag gets neither.
    expect(await dataLakeRepository.findActiveByUserTagsAndEntitlements([], [], undefined, 'bob')).toEqual([]);
  });

  it('owner bypass stays bounded by status: a creator does not retrieve their own DRAFT lake', async () => {
    // Retrieval is active-only across the board, so a draft lake remains browse-only. Pinned so
    // the owner exemption in the resolver is not read as "the owner sees everything they made".
    await dataLakeRepository.create(baseLake({ slug: 'draft', createdByUserId: 'alice', status: 'draft' }));

    expect(await dataLakeRepository.findActiveByUserTagsAndEntitlements([], [], undefined, 'alice')).toEqual([]);
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

  it('admits a public lake as soon as its first member file activates it (#1342)', async () => {
    // The coupling the bug lived in: every lake is created in 'draft', and this catalog is the
    // only place the persisted fileCount is rendered, so a lake that never activates is one no
    // user can reach. Pins the value the transition writes against the value this query wants.
    const created = await dataLakeRepository.create(
      baseLake({ slug: 'brand-new', name: 'Brand New', isPublic: true, status: 'draft' })
    );
    expect((await dataLakeRepository.findPublicLakes()).lakes).toEqual([]);

    await dataLakeRepository.activateIfDraft(created.id);

    expect((await dataLakeRepository.findPublicLakes()).lakes.map(l => l.slug)).toEqual(['brand-new']);
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
    // index, not the separate unique index on datalakeTag. Distinct creators for the same
    // reason against the (createdByUserId, fileTagPrefix) index tested separately below -
    // baseLake defaults fileTagPrefix off the slug, and same-slug-same-creator would otherwise
    // also collide there.
    await dataLakeRepository.create(
      baseLake({ slug: 'dupe', organizationId: 'orgA', createdByUserId: 'ownerA', datalakeTag: 'datalake:orgA:dupe-1' })
    );
    await expect(
      dataLakeRepository.create(
        baseLake({
          slug: 'dupe',
          organizationId: 'orgA',
          createdByUserId: 'ownerB',
          datalakeTag: 'datalake:orgA:dupe-2',
        })
      )
    ).rejects.toThrow();
  });

  it('allows the same slug in different orgs (unique per org, not global)', async () => {
    // Distinct creators so this is attributable to the (organizationId, slug) index alone -
    // baseLake defaults fileTagPrefix off the slug, and same-slug would otherwise also collide
    // on the (createdByUserId, fileTagPrefix) index tested separately below.
    await dataLakeRepository.create(
      baseLake({
        slug: 'shared',
        organizationId: 'orgA',
        createdByUserId: 'ownerA',
        datalakeTag: 'datalake:orgA:shared',
      })
    );
    await expect(
      dataLakeRepository.create(
        baseLake({
          slug: 'shared',
          organizationId: 'orgB',
          createdByUserId: 'ownerB',
          datalakeTag: 'datalake:orgB:shared',
        })
      )
    ).resolves.toBeDefined();
  });
});

describe('DataLakeRepository - fileTagPrefix is unique per creator (DB backstop)', () => {
  setupMongoTest();

  // cleanupTestDB drops the whole DB before each test, so (re)build the model's indexes
  // (including the { createdByUserId, fileTagPrefix } unique index) before asserting the
  // constraint.
  beforeEach(async () => {
    await DataLakeModel.ensureIndexes();
  });

  it('rejects a second lake with the same prefix for the same creator, regardless of org', async () => {
    await dataLakeRepository.create(
      baseLake({ slug: 'first', fileTagPrefix: 'acme:', createdByUserId: 'owner', datalakeTag: 'datalake:first' })
    );
    await expect(
      dataLakeRepository.create(
        baseLake({
          slug: 'second',
          fileTagPrefix: 'acme:',
          createdByUserId: 'owner',
          organizationId: 'orgA',
          datalakeTag: 'datalake:orgA:second',
        })
      )
    ).rejects.toThrow();
  });

  it('allows the same prefix for different creators in the same org (org-scope collisions stay app-level only)', async () => {
    await dataLakeRepository.create(
      baseLake({
        slug: 'first',
        fileTagPrefix: 'acme:',
        createdByUserId: 'ownerA',
        organizationId: 'orgA',
        datalakeTag: 'datalake:orgA:first',
      })
    );
    await expect(
      dataLakeRepository.create(
        baseLake({
          slug: 'second',
          fileTagPrefix: 'acme:',
          createdByUserId: 'ownerB',
          organizationId: 'orgA',
          datalakeTag: 'datalake:orgA:second',
        })
      )
    ).resolves.toBeDefined();
  });

  it('allows the same prefix for different creators who are both org-less (personal lakes)', async () => {
    await dataLakeRepository.create(
      baseLake({ slug: 'first', fileTagPrefix: 'acme:', createdByUserId: 'ownerA', datalakeTag: 'datalake:first' })
    );
    await expect(
      dataLakeRepository.create(
        baseLake({ slug: 'second', fileTagPrefix: 'acme:', createdByUserId: 'ownerB', datalakeTag: 'datalake:second' })
      )
    ).resolves.toBeDefined();
  });

  it('allows a nested (not exact-equal) prefix for the same creator - nesting stays app-level only', async () => {
    await dataLakeRepository.create(
      baseLake({ slug: 'outer', fileTagPrefix: 'acme:', createdByUserId: 'owner', datalakeTag: 'datalake:outer' })
    );
    await expect(
      dataLakeRepository.create(
        baseLake({ slug: 'inner', fileTagPrefix: 'acme:hr:', createdByUserId: 'owner', datalakeTag: 'datalake:inner' })
      )
    ).resolves.toBeDefined();
  });
});

describe('DataLakeRepository - lake-memory extraction lease + continuation cursor (#1501)', () => {
  setupMongoTest();

  const makeLake = () => dataLakeRepository.create(baseLake({ slug: 'mem-lake' }));

  it('claims the lease when free, blocks a fresh concurrent claim, and frees it on release', async () => {
    const lake = await makeLake();
    const t1 = new Date('2026-01-01T00:00:00Z');
    const staleBefore1 = new Date(t1.getTime() - 15 * 60_000);
    expect(await dataLakeRepository.claimLakeMemoryExtraction(lake.id, t1, staleBefore1)).toBe(true);

    // A run a minute later sees a FRESH stamp (not older than its staleBefore) and loses.
    const t2 = new Date('2026-01-01T00:01:00Z');
    const staleBefore2 = new Date(t2.getTime() - 15 * 60_000);
    expect(await dataLakeRepository.claimLakeMemoryExtraction(lake.id, t2, staleBefore2)).toBe(false);

    // The holder releases and the lease is claimable again.
    await dataLakeRepository.releaseLakeMemoryExtraction(lake.id, t1);
    expect((await dataLakeRepository.findById(lake.id))?.lakeMemoryExtractionAt ?? null).toBeNull();
    expect(await dataLakeRepository.claimLakeMemoryExtraction(lake.id, t2, staleBefore2)).toBe(true);
  });

  it('reclaims a lease whose stamp has aged past the window (crashed run, no reconciler)', async () => {
    const lake = await makeLake();
    await DataLakeModel.updateOne(
      { _id: lake.id },
      { $set: { lakeMemoryExtractionAt: new Date('2026-01-01T00:00:00Z') } }
    );

    const now = new Date('2026-01-01T01:00:00Z'); // an hour later - well past the 15-minute lease
    const staleBefore = new Date(now.getTime() - 15 * 60_000);
    expect(await dataLakeRepository.claimLakeMemoryExtraction(lake.id, now, staleBefore)).toBe(true);
  });

  it('release is a compare-and-clear: a late finish does not clear a newer run lease', async () => {
    const lake = await makeLake();
    const mine = new Date('2026-01-01T00:00:00Z');
    // A stale takeover has since replaced my stamp with a newer one.
    const newer = new Date('2026-01-01T00:30:00Z');
    await DataLakeModel.updateOne({ _id: lake.id }, { $set: { lakeMemoryExtractionAt: newer } });

    await dataLakeRepository.releaseLakeMemoryExtraction(lake.id, mine);
    const after = await dataLakeRepository.findById(lake.id);
    expect(after?.lakeMemoryExtractionAt?.getTime()).toBe(newer.getTime());
  });

  it('persists and clears the continuation cursor', async () => {
    const lake = await makeLake();
    await dataLakeRepository.setLakeMemoryCursor(lake.id, 'doc-42');
    expect((await dataLakeRepository.findById(lake.id))?.lakeMemoryCursor).toBe('doc-42');

    await dataLakeRepository.setLakeMemoryCursor(lake.id, null);
    expect((await dataLakeRepository.findById(lake.id))?.lakeMemoryCursor ?? null).toBeNull();
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

describe('DataLakeBatchRepository.setStatusIfActive - guarded non-terminal transition', () => {
  setupMongoTest();

  const activeBatch = () => dataLakeBatchRepository.create({ dataLakeId: 'lake1', userId: 'u1' });

  it('moves a non-terminal batch to the requested in-flight status', async () => {
    const batch = await activeBatch();
    const moved = await dataLakeBatchRepository.setStatusIfActive(batch.id, 'processing');
    expect(moved?.status).toBe('processing');
  });

  it('is a no-op on a terminal batch, so a client flip cannot resurrect a finalized one', async () => {
    const batch = await activeBatch();
    await dataLakeBatchRepository.markTerminalIfActive(batch.id, 'completed_with_errors');

    const moved = await dataLakeBatchRepository.setStatusIfActive(batch.id, 'processing');
    expect(moved).toBeNull();
    // The terminal status is untouched - no revival to 'processing'.
    const fresh = await dataLakeBatchRepository.findById(batch.id);
    expect(fresh?.status).toBe('completed_with_errors');
  });
});

describe('DataLakeBatchRepository.claimFileStatus - from-set gating', () => {
  setupMongoTest();

  const batchWithFile = async (status: import('@bike4mind/common').BatchFileStatus) => {
    const batch = await dataLakeBatchRepository.create({ dataLakeId: 'lake1', userId: 'u1', totalFiles: 1 } as never);
    await dataLakeBatchRepository.appendFiles(batch.id, [{ fabFileId: 'ff1', fileName: 'a.pdf', status }]);
    return batch;
  };

  it('claims a manifest file from uploaded to chunking', async () => {
    const batch = await batchWithFile('uploaded');
    const claimed = await dataLakeBatchRepository.claimFileStatus(batch.id, 'ff1', ['uploaded', 'pending'], 'chunking');
    expect(claimed).toBe(true);
    const fresh = await dataLakeBatchRepository.findById(batch.id);
    expect(fresh?.files[0].status).toBe('chunking');
  });

  it('is a no-op once the entry is failed - the exact mechanism a premature failure exploits (#1412): no success path can ever claim a file back out of failed, so marking one failed before a retry has a chance to succeed is unrecoverable', async () => {
    const batch = await batchWithFile('failed');
    const claimed = await dataLakeBatchRepository.claimFileStatus(
      batch.id,
      'ff1',
      ['chunking', 'uploaded', 'pending'],
      'complete'
    );
    expect(claimed).toBe(false);
    const fresh = await dataLakeBatchRepository.findById(batch.id);
    expect(fresh?.files[0].status).toBe('failed');
  });

  it('a repeated claim to the same target is a no-op (redelivery safety)', async () => {
    const batch = await batchWithFile('uploaded');
    const first = await dataLakeBatchRepository.claimFileStatus(batch.id, 'ff1', ['uploaded', 'pending'], 'chunking');
    const second = await dataLakeBatchRepository.claimFileStatus(batch.id, 'ff1', ['uploaded', 'pending'], 'chunking');
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

describe('DataLakeBatchRepository.touchIfActive - guarded heartbeat', () => {
  setupMongoTest();

  const activeBatch = () => dataLakeBatchRepository.create({ dataLakeId: 'lake1', userId: 'u1' });

  it('advances updatedAt on a non-terminal batch', async () => {
    const batch = await activeBatch();
    const before = batch.updatedAt.getTime();
    await new Promise(resolve => setTimeout(resolve, 5));
    await dataLakeBatchRepository.touchIfActive(batch.id);
    const fresh = await dataLakeBatchRepository.findById(batch.id);
    expect(fresh!.updatedAt.getTime()).toBeGreaterThan(before);
  });

  it('is a no-op on an already-terminal batch, so it cannot resurrect one the pipeline finalized', async () => {
    const batch = await activeBatch();
    const finalized = await dataLakeBatchRepository.markTerminalIfActive(batch.id, 'completed_with_errors');
    const terminalUpdatedAt = finalized!.updatedAt.getTime();

    await new Promise(resolve => setTimeout(resolve, 5));
    await dataLakeBatchRepository.touchIfActive(batch.id);

    const fresh = await dataLakeBatchRepository.findById(batch.id);
    expect(fresh?.status).toBe('completed_with_errors');
    expect(fresh!.updatedAt.getTime()).toBe(terminalUpdatedAt);
  });
});

describe('DataLakeBatchRepository.incrementCounter - additive, not clobbering', () => {
  setupMongoTest();

  // The client's browser-failure accounting and the pipeline's own failures both land on
  // failedFiles; both must go through $inc so a later write never overwrites an earlier one
  // (the bug a client-side $set would reintroduce).
  it('accumulates concurrent-style increments on the same counter', async () => {
    const batch = await dataLakeBatchRepository.create({ dataLakeId: 'lake1', userId: 'u1', totalFiles: 5 } as never);
    await dataLakeBatchRepository.incrementCounter(batch.id, 'failedFiles', 2);
    const after = await dataLakeBatchRepository.incrementCounter(batch.id, 'failedFiles', 1);
    expect(after?.failedFiles).toBe(3);
  });
});

describe('DataLakeBatchRepository.incrementCounters - atomic multi-field increment', () => {
  setupMongoTest();

  it('bumps two counters in one write, so neither can land without the other', async () => {
    const batch = await dataLakeBatchRepository.create({ dataLakeId: 'lake1', userId: 'u1', totalFiles: 5 } as never);
    const after = await dataLakeBatchRepository.incrementCounters(batch.id, {
      failedFiles: 1,
      processingFailedFiles: 1,
    });
    expect(after?.failedFiles).toBe(1);
    expect(after?.processingFailedFiles).toBe(1);
  });

  it('composes with prior single-field increments rather than clobbering them', async () => {
    const batch = await dataLakeBatchRepository.create({ dataLakeId: 'lake1', userId: 'u1', totalFiles: 5 } as never);
    await dataLakeBatchRepository.incrementCounter(batch.id, 'vectorizedFiles', 2);
    const after = await dataLakeBatchRepository.incrementCounters(batch.id, {
      failedFiles: 1,
      processingFailedFiles: 1,
    });
    expect(after?.vectorizedFiles).toBe(2);
    expect(after?.failedFiles).toBe(1);
    expect(after?.processingFailedFiles).toBe(1);
  });

  it('is a no-op on an already-terminal batch, so a late-arriving increment cannot push a counter past what a caller already treated as final', async () => {
    const batch = await dataLakeBatchRepository.create({ dataLakeId: 'lake1', userId: 'u1', totalFiles: 5 } as never);
    await dataLakeBatchRepository.markTerminalIfActive(batch.id, 'completed');

    const result = await dataLakeBatchRepository.incrementCounters(batch.id, {
      failedFiles: 1,
      processingFailedFiles: 1,
    });
    expect(result).toBeNull();

    const fresh = await dataLakeBatchRepository.findById(batch.id);
    expect(fresh?.failedFiles).toBe(0);
    expect(fresh?.processingFailedFiles).toBe(0);
    expect(fresh?.status).toBe('completed');
  });

  it('returns null without querying Mongo for an empty fields object', async () => {
    const batch = await dataLakeBatchRepository.create({ dataLakeId: 'lake1', userId: 'u1', totalFiles: 5 } as never);
    await expect(dataLakeBatchRepository.incrementCounters(batch.id, {})).resolves.toBeNull();
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

describe('DataLakeBatchRepository.setTaxonomyStatusIfActive - guarded taxonomy-phase transition', () => {
  setupMongoTest();

  const activeBatch = () =>
    dataLakeBatchRepository.create({ dataLakeId: 'lake1', userId: 'u1', taxonomyStatus: 'queued' } as never);

  it('moves a matching phase forward and persists extra fields', async () => {
    const batch = await activeBatch();
    const started = new Date('2024-01-01T00:00:00Z');
    const moved = await dataLakeBatchRepository.setTaxonomyStatusIfActive(batch.id, ['queued'], 'analyzing', {
      taxonomyStartedAt: started,
    });
    expect(moved?.taxonomyStatus).toBe('analyzing');
    expect(moved?.taxonomyStartedAt).toEqual(started);
  });

  it('is a no-op when the current phase is not in `from`, so a redelivered message cannot double-process', async () => {
    const batch = await activeBatch();
    await dataLakeBatchRepository.setTaxonomyStatusIfActive(batch.id, ['queued'], 'analyzing');

    // A second, redelivered "queued -> analyzing" claim must lose the guard.
    const lost = await dataLakeBatchRepository.setTaxonomyStatusIfActive(batch.id, ['queued'], 'analyzing');
    expect(lost).toBeNull();
    const fresh = await dataLakeBatchRepository.findById(batch.id);
    expect(fresh?.taxonomyStatus).toBe('analyzing');
  });

  it('persists taxonomySuggestions on the ready transition', async () => {
    const batch = await activeBatch();
    await dataLakeBatchRepository.setTaxonomyStatusIfActive(batch.id, ['queued'], 'analyzing');
    const ready = await dataLakeBatchRepository.setTaxonomyStatusIfActive(batch.id, ['analyzing'], 'ready', {
      taxonomySuggestions: { tags: [], fileAssignments: [] },
    });
    expect(ready?.taxonomyStatus).toBe('ready');
    expect(ready?.taxonomySuggestions).toEqual({ tags: [], fileAssignments: [] });
  });
});

describe('DataLakeBatchRepository.findStuckTaxonomy - global cross-user stale scan', () => {
  setupMongoTest();

  const CUTOFF = new Date('2021-01-01T00:00:00Z');
  const STALE = new Date('2020-01-01T00:00:00Z');

  const seedBatch = async (taxonomyStatus: string, taxonomyStartedAt?: Date) =>
    dataLakeBatchRepository.create({ dataLakeId: 'lake1', userId: 'u1', taxonomyStatus, taxonomyStartedAt } as never);

  it('returns stale non-terminal phases and never-started ones, excluding fresh/ready/none', async () => {
    const neverStarted = await seedBatch('analyzing'); // no taxonomyStartedAt -> treated as maximally stale, not excluded
    const stale = await seedBatch('analyzing', STALE);
    await seedBatch('analyzing', new Date('2022-01-01T00:00:00Z')); // fresh -> excluded
    await seedBatch('ready', STALE); // stale but terminal-ish -> excluded
    await seedBatch('none', STALE); // never opted in -> excluded
    const stuck = await dataLakeBatchRepository.findStuckTaxonomy(CUTOFF);
    // Missing sorts first in ascending order (Mongo treats it like null), so neverStarted leads.
    // Inclusion here matters beyond this scan: it's what makes the never-started batch reachable
    // at all for forceFailStuckTaxonomy's own missing-field handling - if the scan excluded it,
    // that write-side guard would never actually be exercised for such a batch.
    expect(stuck.map(b => b.id)).toEqual([neverStarted.id, stale.id]);
  });

  it('filters on taxonomyStartedAt, not updatedAt - an unrelated write must not hide a stuck batch', async () => {
    const stillStuck = await seedBatch('analyzing', STALE);
    // Simulates an unrelated write (e.g. an ingest counter tick) bumping updatedAt well past
    // the cutoff while taxonomyStartedAt - when this taxonomy attempt actually began - stays
    // fixed. If the query filtered on updatedAt, this batch would wrongly dodge the scan.
    await mongoose.models.DataLakeBatch.updateOne(
      { _id: stillStuck.id },
      { $set: { updatedAt: new Date('2022-01-01T00:00:00Z') } },
      { timestamps: false }
    );

    const stuck = await dataLakeBatchRepository.findStuckTaxonomy(CUTOFF);
    expect(stuck.map(b => b.id)).toEqual([stillStuck.id]);
  });

  it('excludes a batch whose taxonomyStartedAt is fresh even if its updatedAt looks stale', async () => {
    const freshlyReclaimed = await seedBatch('analyzing', new Date('2022-01-01T00:00:00Z'));
    await mongoose.models.DataLakeBatch.updateOne(
      { _id: freshlyReclaimed.id },
      { $set: { updatedAt: STALE } },
      { timestamps: false }
    );

    const stuck = await dataLakeBatchRepository.findStuckTaxonomy(CUTOFF);
    expect(stuck).toEqual([]);
  });

  it('orders oldest-taxonomyStartedAt-first, not by updatedAt - the cron caps results per run and must reconcile the truly-oldest first', async () => {
    // updatedAt is deliberately the OPPOSITE order of taxonomyStartedAt here: if the query
    // sorted on updatedAt (the wrong clock, same bug the filter itself was fixed for), this
    // assertion would see [newest, oldest] instead.
    const oldest = await seedBatch('analyzing', new Date('2019-01-01T00:00:00Z'));
    const newest = await seedBatch('analyzing', new Date('2020-06-01T00:00:00Z'));
    await mongoose.models.DataLakeBatch.updateOne(
      { _id: oldest.id },
      { $set: { updatedAt: new Date('2020-12-31T00:00:00Z') } },
      { timestamps: false }
    );
    await mongoose.models.DataLakeBatch.updateOne(
      { _id: newest.id },
      { $set: { updatedAt: new Date('2020-01-01T00:00:00Z') } },
      { timestamps: false }
    );

    const stuck = await dataLakeBatchRepository.findStuckTaxonomy(CUTOFF);
    expect(stuck.map(b => b.id)).toEqual([oldest.id, newest.id]);
  });
});

describe('DataLakeBatchRepository.forceFailStuckTaxonomy - reconciler write, guarded on status AND staleness', () => {
  setupMongoTest();

  const CUTOFF = new Date('2021-01-01T00:00:00Z');
  const STALE = new Date('2020-01-01T00:00:00Z');
  const FRESH = new Date('2022-01-01T00:00:00Z');

  it('succeeds when status is in `from` and taxonomyStartedAt is before the cutoff', async () => {
    const b = await dataLakeBatchRepository.create({
      dataLakeId: 'lake1',
      userId: 'u1',
      taxonomyStatus: 'analyzing',
      taxonomyStartedAt: STALE,
    } as never);

    const result = await dataLakeBatchRepository.forceFailStuckTaxonomy(
      b.id,
      ['queued', 'analyzing', 'applying'],
      CUTOFF,
      'Timed out waiting for AI tag suggestion'
    );

    expect(result?.taxonomyStatus).toBe('failed');
    expect(result?.taxonomyError).toBe('Timed out waiting for AI tag suggestion');
  });

  it('is a no-op when taxonomyStartedAt is NOT before the cutoff, even if status still matches - the exact race this guard closes', async () => {
    // Simulates a legitimate re-claim (e.g. a manual re-analyze) landing between the
    // reconciler's read and its write: taxonomyStatus is still non-terminal, but
    // taxonomyStartedAt now reflects the NEW attempt, not the stale one the reconciler saw.
    const b = await dataLakeBatchRepository.create({
      dataLakeId: 'lake1',
      userId: 'u1',
      taxonomyStatus: 'analyzing',
      taxonomyStartedAt: FRESH,
    } as never);

    const result = await dataLakeBatchRepository.forceFailStuckTaxonomy(
      b.id,
      ['queued', 'analyzing', 'applying'],
      CUTOFF,
      'Timed out waiting for AI tag suggestion'
    );

    expect(result).toBeNull();
    const fresh = await dataLakeBatchRepository.findById(b.id);
    expect(fresh?.taxonomyStatus).toBe('analyzing'); // untouched - the re-claim's work survives
  });

  it('is a no-op when status does not match, regardless of staleness', async () => {
    const b = await dataLakeBatchRepository.create({
      dataLakeId: 'lake1',
      userId: 'u1',
      taxonomyStatus: 'ready',
      taxonomyStartedAt: STALE,
    } as never);

    const result = await dataLakeBatchRepository.forceFailStuckTaxonomy(
      b.id,
      ['queued', 'analyzing', 'applying'],
      CUTOFF,
      'Timed out waiting for AI tag suggestion'
    );

    expect(result).toBeNull();
  });

  it('succeeds when taxonomyStartedAt is missing entirely, not just when it is before the cutoff', async () => {
    // reconcileStuckTaxonomy.ts treats a missing taxonomyStartedAt as "definitely stuck" (epoch
    // 0). A plain $lt guard would never match a missing field, silently no-opping forever on
    // such a batch - this proves the guard's $not/$gte form closes that gap.
    const b = await dataLakeBatchRepository.create({
      dataLakeId: 'lake1',
      userId: 'u1',
      taxonomyStatus: 'analyzing',
    } as never);

    const result = await dataLakeBatchRepository.forceFailStuckTaxonomy(
      b.id,
      ['queued', 'analyzing', 'applying'],
      CUTOFF,
      'Timed out waiting for AI tag suggestion'
    );

    expect(result?.taxonomyStatus).toBe('failed');
  });
});

describe('DataLakeBatchRepository.findActiveByUserId - list-surface query', () => {
  setupMongoTest();

  it('excludes the per-file manifest - this is a list view, never a per-file read', async () => {
    await dataLakeBatchRepository.create({
      dataLakeId: 'lake1',
      userId: 'u1',
      status: 'processing',
      files: [{ fabFileId: 'f1', fileName: 'a.txt' }],
    } as never);

    const [active] = await dataLakeBatchRepository.findActiveByUserId('u1');
    // A `.select('-files')` exclusion omits the key entirely (not an empty array) - this
    // asserts the projection is actually active, not just that the field happens to be empty.
    expect(active.files).toBeUndefined();
  });

  it('excludes taxonomySuggestions.fileAssignments - ingest and taxonomy are independent clocks, so an applied-taxonomy batch can still be ingest-active', async () => {
    await dataLakeBatchRepository.create({
      dataLakeId: 'lake1',
      userId: 'u1',
      status: 'processing',
      taxonomyStatus: 'applied',
      taxonomySuggestions: {
        tags: [{ suffix: 'type:invoice', originalName: 'acme:type:invoice', strength: 0.9, source: 'ai' }],
        fileAssignments: [{ relativePath: 'a.txt', suggestedTags: [{ name: 'acme:type:invoice', strength: 0.9 }] }],
      },
    } as never);

    const [active] = await dataLakeBatchRepository.findActiveByUserId('u1');
    expect(active.taxonomySuggestions?.tags).toEqual([
      { suffix: 'type:invoice', originalName: 'acme:type:invoice', strength: 0.9, source: 'ai' },
    ]);
    expect(active.taxonomySuggestions?.fileAssignments).toBeUndefined();
  });
});

describe('DataLakeBatchRepository.findActiveByDataLakeId - teardown-scan query', () => {
  setupMongoTest();

  it('excludes the per-file manifest - callers only ever read .id', async () => {
    await dataLakeBatchRepository.create({
      dataLakeId: 'lake1',
      userId: 'u1',
      status: 'processing',
      files: [{ fabFileId: 'f1', fileName: 'a.txt' }],
    } as never);

    const [active] = await dataLakeBatchRepository.findActiveByDataLakeId('lake1');
    expect(active.files).toBeUndefined();
  });

  it('excludes taxonomySuggestions.fileAssignments too', async () => {
    await dataLakeBatchRepository.create({
      dataLakeId: 'lake1',
      userId: 'u1',
      status: 'processing',
      taxonomyStatus: 'applied',
      taxonomySuggestions: {
        tags: [{ suffix: 'type:invoice', originalName: 'acme:type:invoice', strength: 0.9, source: 'ai' }],
        fileAssignments: [{ relativePath: 'a.txt', suggestedTags: [{ name: 'acme:type:invoice', strength: 0.9 }] }],
      },
    } as never);

    const [active] = await dataLakeBatchRepository.findActiveByDataLakeId('lake1');
    expect(active.taxonomySuggestions?.fileAssignments).toBeUndefined();
  });

  it('scopes to the requesting lake only', async () => {
    await dataLakeBatchRepository.create({ dataLakeId: 'lake1', userId: 'u1', status: 'processing' } as never);
    await dataLakeBatchRepository.create({ dataLakeId: 'lake2', userId: 'u1', status: 'processing' } as never);

    const active = await dataLakeBatchRepository.findActiveByDataLakeId('lake1');
    expect(active).toHaveLength(1);
  });
});

describe('DataLakeBatchRepository.findTaxonomyAttentionByUserId - list-surface query', () => {
  setupMongoTest();

  const seed = (taxonomyStatus: string, userId = 'u1') =>
    dataLakeBatchRepository.create({ dataLakeId: 'lake1', userId, taxonomyStatus } as never);

  it('includes queued/analyzing/ready/failed but not none or applied', async () => {
    const queued = await seed('queued');
    const analyzing = await seed('analyzing');
    const ready = await seed('ready');
    const failed = await seed('failed');
    await seed('none');
    await seed('applied');

    const attention = await dataLakeBatchRepository.findTaxonomyAttentionByUserId('u1');
    expect(attention.map(b => b.id).sort()).toEqual([queued.id, analyzing.id, ready.id, failed.id].sort());
  });

  it('scopes to the requesting user only', async () => {
    await seed('ready', 'u1');
    await seed('ready', 'u2');
    const attention = await dataLakeBatchRepository.findTaxonomyAttentionByUserId('u1');
    expect(attention).toHaveLength(1);
  });

  it('excludes the per-file manifest - this is a list view, never a per-file read', async () => {
    await dataLakeBatchRepository.create({
      dataLakeId: 'lake1',
      userId: 'u1',
      taxonomyStatus: 'ready',
      files: [{ fabFileId: 'f1', fileName: 'a.txt' }],
    } as never);

    const [attention] = await dataLakeBatchRepository.findTaxonomyAttentionByUserId('u1');
    // A `.select('-files')` exclusion omits the key entirely (not an empty array) - this
    // asserts the projection is actually active, not just that the field happens to be empty.
    expect(attention.files).toBeUndefined();
  });

  it('excludes taxonomySuggestions.fileAssignments but keeps tags', async () => {
    await dataLakeBatchRepository.create({
      dataLakeId: 'lake1',
      userId: 'u1',
      taxonomyStatus: 'ready',
      taxonomySuggestions: {
        tags: [{ suffix: 'type:invoice', originalName: 'acme:type:invoice', strength: 0.9, source: 'ai' }],
        fileAssignments: [{ relativePath: 'a.txt', suggestedTags: [{ name: 'acme:type:invoice', strength: 0.9 }] }],
      },
    } as never);

    const [attention] = await dataLakeBatchRepository.findTaxonomyAttentionByUserId('u1');
    expect(attention.taxonomySuggestions?.tags).toEqual([
      { suffix: 'type:invoice', originalName: 'acme:type:invoice', strength: 0.9, source: 'ai' },
    ]);
    expect(attention.taxonomySuggestions?.fileAssignments).toBeUndefined();
  });

  it('orders most-recently-updated first and caps a large backlog', async () => {
    // A user with no exit path for old suggestions (no dismiss yet) can accumulate an
    // unbounded backlog - seed past the cap and confirm both the order and the bound.
    // Uses an explicit small `limit` override (production default is 500) so the test
    // stays fast without seeding hundreds of documents.
    const batches = [];
    for (let i = 0; i < 6; i++) {
      batches.push(await seed('ready'));
      // Force each create's updatedAt strictly later than the last (timestamps:true otherwise
      // collapses same-millisecond creates to an unstable order).
      await mongoose.models.DataLakeBatch.updateOne(
        { _id: batches[i].id },
        { $set: { updatedAt: new Date(2024, 0, 1, 0, 0, i) } },
        { timestamps: false }
      );
    }

    const attention = await dataLakeBatchRepository.findTaxonomyAttentionByUserId('u1', 5);
    expect(attention).toHaveLength(5);
    // Most recently updated (highest i, seeded last) comes first.
    expect(attention[0].id).toBe(batches[5].id);
    expect(attention.map(b => b.id)).not.toContain(batches[0].id);
  });

  it('runs the no-arg (default-limit) path without requiring a caller to pass one', async () => {
    // Only confirms the omitted-argument call works end to end - it can't practically pin the
    // exact default value (500) without seeding past it, which the explicit-limit test above
    // already covers for the cap-enforcement logic itself. The literal default lives at the
    // call site (`limit = 500` in the method signature) and is reviewed there.
    await seed('ready');
    const attention = await dataLakeBatchRepository.findTaxonomyAttentionByUserId('u1');
    expect(attention).toHaveLength(1);
  });
});

describe('DataLakeBatchRepository.findActiveTaxonomyByUserId - reconciler input', () => {
  setupMongoTest();

  const seed = (taxonomyStatus: string, userId = 'u1') =>
    dataLakeBatchRepository.create({ dataLakeId: 'lake1', userId, taxonomyStatus } as never);

  it('includes only queued/analyzing/applying, not ready/failed/none/applied', async () => {
    const queued = await seed('queued');
    const analyzing = await seed('analyzing');
    const applying = await seed('applying');
    await seed('ready');
    await seed('failed');
    await seed('none');
    await seed('applied');

    const active = await dataLakeBatchRepository.findActiveTaxonomyByUserId('u1');
    expect(active.map(b => b.id).sort()).toEqual([queued.id, analyzing.id, applying.id].sort());
  });

  it('is not capped, unlike findTaxonomyAttentionByUserId - a stale batch must not be excluded', async () => {
    const batches = [];
    for (let i = 0; i < 55; i++) {
      batches.push(await seed('analyzing'));
      await mongoose.models.DataLakeBatch.updateOne(
        { _id: batches[i].id },
        { $set: { updatedAt: new Date(2024, 0, 1, 0, 0, i) } },
        { timestamps: false }
      );
    }

    const active = await dataLakeBatchRepository.findActiveTaxonomyByUserId('u1');
    expect(active).toHaveLength(55);
    expect(active.map(b => b.id)).toContain(batches[0].id);
  });

  it('excludes the per-file manifest', async () => {
    await dataLakeBatchRepository.create({
      dataLakeId: 'lake1',
      userId: 'u1',
      taxonomyStatus: 'analyzing',
      files: [{ fabFileId: 'f1', fileName: 'a.txt' }],
    } as never);

    const [active] = await dataLakeBatchRepository.findActiveTaxonomyByUserId('u1');
    expect(active.files).toBeUndefined();
  });

  it('excludes taxonomySuggestions.fileAssignments but keeps tags', async () => {
    await dataLakeBatchRepository.create({
      dataLakeId: 'lake1',
      userId: 'u1',
      taxonomyStatus: 'applying',
      taxonomySuggestions: {
        tags: [{ suffix: 'type:invoice', originalName: 'acme:type:invoice', strength: 0.9, source: 'ai' }],
        fileAssignments: [{ relativePath: 'a.txt', suggestedTags: [{ name: 'acme:type:invoice', strength: 0.9 }] }],
      },
    } as never);

    const [active] = await dataLakeBatchRepository.findActiveTaxonomyByUserId('u1');
    expect(active.taxonomySuggestions?.tags).toEqual([
      { suffix: 'type:invoice', originalName: 'acme:type:invoice', strength: 0.9, source: 'ai' },
    ]);
    expect(active.taxonomySuggestions?.fileAssignments).toBeUndefined();
  });
});

describe('DataLakeRepository — systemPrompt round-trip (#843)', () => {
  setupMongoTest();

  it('persists and reads back a systemPrompt uncapped (long value survives)', async () => {
    const longPrompt = 'x'.repeat(20000);
    const created = await dataLakeRepository.create(baseLake({ slug: 'prompted', systemPrompt: longPrompt }));
    const found = await dataLakeRepository.findById(created.id);
    expect(found?.systemPrompt).toBe(longPrompt);
  });

  it('omits systemPrompt when never set (feature is opt-in)', async () => {
    const created = await dataLakeRepository.create(baseLake({ slug: 'unprompted' }));
    const found = await dataLakeRepository.findById(created.id);
    expect(found?.systemPrompt).toBeUndefined();
  });
});

describe('DataLakeRepository.activateIfDraft', () => {
  setupMongoTest();

  it('flips a draft lake to active, and only the first call does it', async () => {
    const created = await dataLakeRepository.create(baseLake({ slug: 'fresh', status: 'draft' }));

    expect(await dataLakeRepository.activateIfDraft(created.id)).toBe(true);
    expect((await dataLakeRepository.findById(created.id))?.status).toBe('active');
    expect(await dataLakeRepository.activateIfDraft(created.id)).toBe(false);
  });

  it('activates a lake stored before the status field existed', async () => {
    // Inserted through the driver, not the model: mongoose would stamp the schema default and
    // there would be no missing-field row left to test.
    const { insertedId } = await DataLakeModel.collection.insertOne({
      name: 'legacy',
      slug: 'legacy',
      fileTagPrefix: 'legacy:',
      datalakeTag: 'datalake:legacy',
      createdByUserId: 'admin',
    });

    expect(await dataLakeRepository.activateIfDraft(insertedId.toString())).toBe(true);
    expect((await dataLakeRepository.findById(insertedId.toString()))?.status).toBe('active');
  });

  it('leaves every other status untouched', async () => {
    // The teardown statuses matter most: a membership door hands over a lake document it read
    // before the lifecycle write, so a guard on the caller's copy would resurrect these.
    for (const status of ['active', 'archiving', 'archived', 'restoring', 'deleting', 'deleted'] as const) {
      const created = await dataLakeRepository.create(baseLake({ slug: `lake-${status}`, status }));

      expect(await dataLakeRepository.activateIfDraft(created.id)).toBe(false);
      expect((await dataLakeRepository.findById(created.id))?.status).toBe(status);
    }
  });

  it('reports false for an id that matches no lake', async () => {
    expect(await dataLakeRepository.activateIfDraft(new mongoose.Types.ObjectId().toString())).toBe(false);
  });
});

describe('DataLakeRepository teardown stamp', () => {
  setupMongoTest();

  // Phase-1 delete keys the restore to the stamp it records here. If the schema were missing the
  // field mongoose would drop it on write without complaint, and every restore would silently fall
  // back to reversing the whole lake - which a service-level mock cannot detect.
  it('round-trips the stamp as a Date', async () => {
    const stamp = new Date('2026-06-01T00:00:00.000Z');
    const created = await dataLakeRepository.create(baseLake({ slug: 'torn-down' }));

    await dataLakeRepository.update({ id: created.id, filesDeletedAt: stamp });

    const found = await dataLakeRepository.findById(created.id);
    expect(found?.filesDeletedAt).toBeInstanceOf(Date);
    expect(found?.filesDeletedAt?.getTime()).toBe(stamp.getTime());
  });

  it('clears a spent stamp back to null', async () => {
    const created = await dataLakeRepository.create(
      baseLake({ slug: 'restored', filesDeletedAt: new Date('2026-06-01T00:00:00.000Z') })
    );

    await dataLakeRepository.update({ id: created.id, filesDeletedAt: null });

    expect((await dataLakeRepository.findById(created.id))?.filesDeletedAt ?? null).toBeNull();
  });

  it('leaves the stamp unset on a lake that was never torn down', async () => {
    const created = await dataLakeRepository.create(baseLake({ slug: 'untouched' }));
    expect((await dataLakeRepository.findById(created.id))?.filesDeletedAt ?? null).toBeNull();
  });

  it('claims an unset stamp and echoes it back', async () => {
    const at = new Date('2026-06-01T00:00:00.000Z');
    const created = await dataLakeRepository.create(baseLake({ slug: 'claiming' }));

    expect((await dataLakeRepository.claimFilesDeletedAt(created.id, at))?.getTime()).toBe(at.getTime());
    expect((await dataLakeRepository.findById(created.id))?.filesDeletedAt?.getTime()).toBe(at.getTime());
  });

  it('refuses to overwrite a claimed stamp and hands back the holder', async () => {
    // The concurrency guard: the second teardown must sweep under the first one's stamp, or it
    // records a mark no row carries and the restore keyed to it reverses nothing.
    const first = new Date('2026-06-01T00:00:00.000Z');
    const second = new Date('2026-06-02T00:00:00.000Z');
    const created = await dataLakeRepository.create(baseLake({ slug: 'contended' }));
    await dataLakeRepository.claimFilesDeletedAt(created.id, first);

    expect((await dataLakeRepository.claimFilesDeletedAt(created.id, second))?.getTime()).toBe(first.getTime());
    expect((await dataLakeRepository.findById(created.id))?.filesDeletedAt?.getTime()).toBe(first.getTime());
  });

  it('claims again once a restore has cleared the stamp', async () => {
    const first = new Date('2026-06-01T00:00:00.000Z');
    const second = new Date('2026-06-02T00:00:00.000Z');
    const created = await dataLakeRepository.create(baseLake({ slug: 'recycled' }));
    await dataLakeRepository.claimFilesDeletedAt(created.id, first);
    await dataLakeRepository.update({ id: created.id, filesDeletedAt: null });

    expect((await dataLakeRepository.claimFilesDeletedAt(created.id, second))?.getTime()).toBe(second.getTime());
  });
});

// Mirrors the delete-axis teardown stamp above, on the archive axis - same set-if-unset
// concurrency guard, same round-trip contract, so restore can bound its archive-clear to the
// batch this lake's own archive wrote.
describe('DataLakeRepository archive stamp', () => {
  setupMongoTest();

  it('round-trips the stamp as a Date', async () => {
    const stamp = new Date('2026-05-01T00:00:00.000Z');
    const created = await dataLakeRepository.create(baseLake({ slug: 'archived-lake' }));

    await dataLakeRepository.update({ id: created.id, filesArchivedAt: stamp });

    const found = await dataLakeRepository.findById(created.id);
    expect(found?.filesArchivedAt).toBeInstanceOf(Date);
    expect(found?.filesArchivedAt?.getTime()).toBe(stamp.getTime());
  });

  it('clears a spent stamp back to null', async () => {
    const created = await dataLakeRepository.create(
      baseLake({ slug: 'unarchived', filesArchivedAt: new Date('2026-05-01T00:00:00.000Z') })
    );

    await dataLakeRepository.update({ id: created.id, filesArchivedAt: null });

    expect((await dataLakeRepository.findById(created.id))?.filesArchivedAt ?? null).toBeNull();
  });

  it('leaves the stamp unset on a lake that was never archived', async () => {
    const created = await dataLakeRepository.create(baseLake({ slug: 'untouched-archive' }));
    expect((await dataLakeRepository.findById(created.id))?.filesArchivedAt ?? null).toBeNull();
  });

  it('claims an unset stamp and echoes it back', async () => {
    const at = new Date('2026-05-01T00:00:00.000Z');
    const created = await dataLakeRepository.create(baseLake({ slug: 'claiming-archive' }));

    expect((await dataLakeRepository.claimFilesArchivedAt(created.id, at))?.getTime()).toBe(at.getTime());
    expect((await dataLakeRepository.findById(created.id))?.filesArchivedAt?.getTime()).toBe(at.getTime());
  });

  it('refuses to overwrite a claimed stamp and hands back the holder', async () => {
    const first = new Date('2026-05-01T00:00:00.000Z');
    const second = new Date('2026-05-02T00:00:00.000Z');
    const created = await dataLakeRepository.create(baseLake({ slug: 'contended-archive' }));
    await dataLakeRepository.claimFilesArchivedAt(created.id, first);

    expect((await dataLakeRepository.claimFilesArchivedAt(created.id, second))?.getTime()).toBe(first.getTime());
    expect((await dataLakeRepository.findById(created.id))?.filesArchivedAt?.getTime()).toBe(first.getTime());
  });

  it('claims again once an unarchive has cleared the stamp', async () => {
    const first = new Date('2026-05-01T00:00:00.000Z');
    const second = new Date('2026-05-02T00:00:00.000Z');
    const created = await dataLakeRepository.create(baseLake({ slug: 'recycled-archive' }));
    await dataLakeRepository.claimFilesArchivedAt(created.id, first);
    await dataLakeRepository.update({ id: created.id, filesArchivedAt: null });

    expect((await dataLakeRepository.claimFilesArchivedAt(created.id, second))?.getTime()).toBe(second.getTime());
  });
});

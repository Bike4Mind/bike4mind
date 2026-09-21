import { describe, it, expect } from 'vitest';
import type { AccessContext, IDataLake } from '@bike4mind/common';
import { dataLakeRepository } from './DataLakeModel';
import { setupMongoTest } from '../../__test__/utils';

/**
 * `createdByUserId` is immutable: ownership moves by minting an `owner`-role grant, never by
 * rewriting the field. So every query arm keyed on bare creator provenance keeps admitting a
 * creator whose ownership has since moved off - `findAccessible`'s owner arm (pinned in
 * DataLakeModel.accessArms.test.ts against the pure builder), and the two pinned HERE against real
 * Mongo because neither has a pure builder to assert on:
 *
 *   - `findActiveByUserTagsAndEntitlements`'s owner bypass - the RETRIEVAL path, which reaches file
 *     CONTENT rather than a row in a list;
 *   - `findPublicLakes`'s creator arm - the discover catalog, where that arm's job is to LIFT a
 *     lake's post-publish gate for its owner.
 *
 * The exclusion set itself is resolved app-side (`supersededOwnLakeIdsFor` in @bike4mind/services,
 * unreachable from this package) and is pinned there; what is pinned here is what the queries do
 * with it. The load-bearing property in both cases is the NARROWNESS: the exclusion may only ever
 * close the creator arm, so a superseded creator who still holds a grant, the lake's tag, or its
 * entitlement keeps reaching it through the arm that actually authorizes them.
 */

const ctx = (userId: string, over: Partial<AccessContext> = {}): AccessContext => ({
  userId,
  isAdmin: false,
  userTags: [],
  organizationIds: [],
  entitlementKeys: [],
  administeredOrgIds: [],
  ...over,
});

/** Private by default: no gate, no org, not public - so ONLY the creator arm can return it. */
const privateLake = (slug: string, createdByUserId: string): Omit<IDataLake, 'id'> =>
  ({
    slug,
    name: slug,
    fileTagPrefix: `${slug}:`,
    datalakeTag: `datalake:${slug}`,
    createdByUserId,
    status: 'active',
  }) as Omit<IDataLake, 'id'>;

/** Published, then gated with a tag the creator does not hold - so only the creator arm lifts it. */
const gatedPublicLake = (slug: string, createdByUserId: string): Omit<IDataLake, 'id'> =>
  ({
    ...privateLake(slug, createdByUserId),
    isPublic: true,
    requiredUserTag: 'a-tag-nobody-here-holds',
  }) as Omit<IDataLake, 'id'>;

const retrievedSlugs = async (
  userId: string,
  opts?: Parameters<typeof dataLakeRepository.findActiveByUserTagsAndEntitlements>[4],
  userTags: string[] = []
) =>
  (await dataLakeRepository.findActiveByUserTagsAndEntitlements(userTags, [], [], userId, opts))
    .map(l => l.slug)
    .sort();

describe('retrieval owner bypass - a creator superseded as owner stops grounding', () => {
  setupMongoTest();

  it('returns the lake on bare provenance, and withholds it once ownership has moved', async () => {
    const lake = await dataLakeRepository.create(privateLake('handbook', 'alice'));

    expect(await retrievedSlugs('alice')).toEqual(['handbook']);
    expect(await retrievedSlugs('alice', { supersededOwnLakeIds: [lake.id] })).toEqual([]);
  });

  it('keeps it for a superseded creator who still holds a GRANT on it', async () => {
    // The narrowness property. A transfer demotes the prior owner to `curator` rather than
    // stripping them, so this is the ordinary post-transfer state, not an edge case: closing the
    // creator arm must not cost them the access their grant confers.
    const lake = await dataLakeRepository.create(privateLake('handbook', 'alice'));

    expect(await retrievedSlugs('alice', { supersededOwnLakeIds: [lake.id], grantedLakeIds: [lake.id] })).toEqual([
      'handbook',
    ]);
  });

  it('keeps it for a superseded creator who holds the lake TAG', async () => {
    const lake = await dataLakeRepository.create({
      ...privateLake('handbook', 'alice'),
      requiredUserTag: 'clinician',
    } as Omit<IDataLake, 'id'>);

    expect(await retrievedSlugs('alice', { supersededOwnLakeIds: [lake.id] }, ['clinician'])).toEqual(['handbook']);
  });

  it('withholds only the named lake, not every lake the caller created', async () => {
    const kept = await dataLakeRepository.create(privateLake('kept', 'alice'));
    const moved = await dataLakeRepository.create(privateLake('moved', 'alice'));

    expect(await retrievedSlugs('alice', { supersededOwnLakeIds: [moved.id] })).toEqual(['kept']);
    expect(kept.id).not.toEqual(moved.id);
  });

  it('survives an uncastable id in the exclusion list instead of failing the whole query', async () => {
    // A legacy/bad grant row must not take the caller's whole retrieval scope down with it - the
    // usable ids still apply, the rest are dropped (usableObjectIds).
    const lake = await dataLakeRepository.create(privateLake('handbook', 'alice'));

    expect(await retrievedSlugs('alice', { supersededOwnLakeIds: ['legacy-uuid-not-an-objectid', lake.id] })).toEqual(
      []
    );
  });
});

describe('discover catalog creator arm - a superseded creator stops getting the gate lifted', () => {
  setupMongoTest();

  const catalogSlugs = async (viewer: AccessContext, opts?: Parameters<typeof dataLakeRepository.findPublicLakes>[1]) =>
    (await dataLakeRepository.findPublicLakes(viewer, opts)).lakes.map(l => l.slug).sort();

  it('lifts the post-publish gate for the creator, and stops once ownership has moved', async () => {
    const lake = await dataLakeRepository.create(gatedPublicLake('atlas', 'alice'));

    expect(await catalogSlugs(ctx('alice'))).toEqual(['atlas']);
    expect(await catalogSlugs(ctx('alice'), { supersededOwnLakeIds: [lake.id] })).toEqual([]);
  });

  it('keeps it for a superseded creator who holds the gate on their own merits', async () => {
    const lake = await dataLakeRepository.create(gatedPublicLake('atlas', 'alice'));

    expect(
      await catalogSlugs(ctx('alice', { userTags: ['a-tag-nobody-here-holds'] }), {
        supersededOwnLakeIds: [lake.id],
      })
    ).toEqual(['atlas']);
  });

  it('keeps it for a superseded creator who holds a GRANT on it', async () => {
    const lake = await dataLakeRepository.create(gatedPublicLake('atlas', 'alice'));

    expect(await catalogSlugs(ctx('alice'), { supersededOwnLakeIds: [lake.id], grantedLakeIds: [lake.id] })).toEqual([
      'atlas',
    ]);
  });

  it('narrows `total` in step with the page, so load-more cannot re-surface the row', async () => {
    // `total` is counted off the same filter; asserting it separately is what stops a future edit
    // from narrowing only the page query and leaving the UI claiming a result it never shows.
    const lake = await dataLakeRepository.create(gatedPublicLake('atlas', 'alice'));

    const { lakes, total } = await dataLakeRepository.findPublicLakes(ctx('alice'), {
      supersededOwnLakeIds: [lake.id],
    });

    expect(lakes).toEqual([]);
    expect(total).toBe(0);
  });

  it('leaves the admin catalog alone - it emits no per-caller reach arm at all', async () => {
    const lake = await dataLakeRepository.create(gatedPublicLake('atlas', 'alice'));

    expect(await catalogSlugs(ctx('alice', { isAdmin: true }), { supersededOwnLakeIds: [lake.id] })).toEqual(['atlas']);
  });
});

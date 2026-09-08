import { describe, it, expect } from 'vitest';
import type { AccessContext, IDataLake } from '@bike4mind/common';
import { dataLakeRepository } from './DataLakeModel';
import { dataLakeAccessGrantRepository } from './DataLakeAccessGrantModel';
import { setupMongoTest } from '../../__test__/utils';

/**
 * The grant-scope AGREEMENT invariant: a lake a caller reaches ONLY through an access grant must be
 * returned by the BROWSE read (`findAccessible`, behind listDataLakes) and by the RETRIEVAL read
 * (`findActiveByUserTagsAndEntitlements`, behind getDynamicDataLakeAccess) alike. Retrieval is
 * documented as a subset of browse, never the reverse (apps/client/server/dataLakes/
 * resolveRetrievalLakeScope) - and only the browse query used to carry a grant arm, so a
 * transferred-owner lake listed and browsed but never grounded a chat answer.
 *
 * Both predicates are exercised with the SAME grant-resolved id set, which is how the production
 * callers get theirs (`grantedLakeReachFor` in @bike4mind/services, unreachable from this package -
 * hence the local mirror of its owner/curator filter below). The lake here is deliberately gated by
 * a tag its grantee does not hold, so neither query can return it by any arm other than the grant.
 */

const gatedLake = (slug: string, createdByUserId: string): Omit<IDataLake, 'id'> =>
  ({
    slug,
    name: slug,
    fileTagPrefix: `${slug}:`,
    datalakeTag: `datalake:${slug}`,
    createdByUserId,
    status: 'active',
    requiredUserTag: 'a-tag-nobody-here-holds',
  }) as Omit<IDataLake, 'id'>;

const context = (userId: string): AccessContext => ({
  userId,
  isAdmin: false,
  userTags: [],
  organizationIds: [],
  entitlementKeys: [],
  administeredOrgIds: [],
});

/**
 * The USER owner/curator half of `grantedLakeReachFor` (@bike4mind/services), which is the half that
 * resolves whatever the read-grant cutover says. Reader and org-principal rows are left out on BOTH
 * sides on purpose: this file pins the agreement between the two queries for a given id set, not the
 * role/principal split that decides the set - that is pinned at the resolver
 * (b4m-core/services/src/dataLakeService/getDynamicDataLakeTags.test.ts) and, for the org half's
 * per-issuer containment, in DataLakeModel.test.ts.
 */
const grantedUserLakeIdsFor = async (userId: string): Promise<string[]> =>
  (await dataLakeAccessGrantRepository.listByPrincipal('user', userId, { activeAsOf: new Date() }))
    .filter(g => g.role === 'owner' || g.role === 'curator')
    .map(g => g.dataLakeId);

const browsableSlugs = async (userId: string) =>
  (await dataLakeRepository.findAccessible(context(userId), { grantedLakeIds: await grantedUserLakeIdsFor(userId) }))
    .map(l => l.slug)
    .sort();

const retrievableSlugs = async (userId: string) =>
  (
    await dataLakeRepository.findActiveByUserTagsAndEntitlements([], [], [], userId, {
      grantedLakeIds: await grantedUserLakeIdsFor(userId),
    })
  )
    .map(l => l.slug)
    .sort();

describe('data-lake grant scope: chat retrieval agrees with browse', () => {
  setupMongoTest();

  /** Ownership transfer as `transferLakeOwnership` leaves it: new owner stamped, prior owner curator. */
  const transferred = async (slug: string, fromUserId: string, toUserId: string) => {
    const lake = await dataLakeRepository.create(gatedLake(slug, fromUserId));
    await dataLakeRepository.update({ ...lake, createdByUserId: toUserId });
    await dataLakeAccessGrantRepository.upsertGrant({
      dataLakeId: lake.id,
      principalType: 'user',
      principalId: toUserId,
      role: 'owner',
      grantedByUserId: fromUserId,
    });
    await dataLakeAccessGrantRepository.upsertGrant({
      dataLakeId: lake.id,
      principalType: 'user',
      principalId: fromUserId,
      role: 'curator',
      grantedByUserId: fromUserId,
    });
    return lake;
  };

  it('retrieves a transferred lake for the demoted curator, exactly as it browses', async () => {
    // The load-bearing case: the curator is no longer the creator, holds none of the lake's gate,
    // and shares no org with it - the grant is their only claim. Before the retrieval query grew a
    // grant arm this listed but returned nothing to ground on.
    await transferred('handbook', 'old-owner', 'new-owner');

    expect(await browsableSlugs('old-owner')).toEqual(['handbook']);
    expect(await retrievableSlugs('old-owner')).toEqual(['handbook']);
  });

  it('retrieves it for the new owner too, whose claim is the stamped creator plus the grant', async () => {
    await transferred('handbook', 'old-owner', 'new-owner');

    expect(await browsableSlugs('new-owner')).toEqual(['handbook']);
    expect(await retrievableSlugs('new-owner')).toEqual(['handbook']);
  });

  it('returns it to NEITHER read for a caller with no grant, no membership and no gate', async () => {
    // The opposite failure: an arm that widened past the grant would satisfy the assertions above
    // while handing the lake to everyone. A stranger resolves an empty granted-id set, so the arm
    // is absent from both queries entirely.
    await transferred('handbook', 'old-owner', 'new-owner');

    expect(await browsableSlugs('stranger')).toEqual([]);
    expect(await retrievableSlugs('stranger')).toEqual([]);
  });

  it('excludes a reader-only grant from both reads when the resolved id set omits it', async () => {
    const lake = await dataLakeRepository.create(gatedLake('reader-only', 'owner'));
    await dataLakeAccessGrantRepository.upsertGrant({
      dataLakeId: lake.id,
      principalType: 'user',
      principalId: 'reader',
      role: 'reader',
      grantedByUserId: 'owner',
    });

    expect(await browsableSlugs('reader')).toEqual([]);
    expect(await retrievableSlugs('reader')).toEqual([]);
  });

  /**
   * The INJECTION read (getAccessibleDataLakePrompts, #2495) is a third consumer of this same
   * grant-resolved id set - and the only one that compares those ids IN MEMORY
   * (`grantedLakeIds.has(lake.id)`) instead of handing them to Mongo as a query arm. Every
   * assertion above compares slugs, so a divergence between a grant's stored `dataLakeId` and the
   * returned document's `id` would satisfy all of them while making the injection arm deny
   * SILENTLY - the #1281 normalizeId failure mode, and the hard one to notice because it looks
   * exactly like "this lake has no prompt". Pin the two forms against each other directly.
   *
   * Caveat, same as the rest of this file: the id set comes from the LOCAL mirror of
   * `grantedUserLakeIdsFor` above, not the real helper (unreachable from this package). So this pins the
   * persisted `dataLakeId` against the returned document's `id` - the load-bearing bit - and not the
   * production helper's own output.
   */
  it('resolves grant ids in the same string form the returned documents carry', async () => {
    const lake = await transferred('handbook', 'old-owner', 'new-owner');

    const grantedIds = new Set(await grantedLakeIdsFor('old-owner'));
    const [retrieved] = await dataLakeRepository.findActiveByUserTagsAndEntitlements([], [], [], 'old-owner', [
      ...grantedIds,
    ]);

    expect(retrieved).toBeDefined();
    expect(retrieved.id).toBe(lake.id);
    // The assertion the injection arm actually rests on.
    expect(grantedIds.has(retrieved.id)).toBe(true);
  });

  it('drops a LAPSED owner/curator grant from both reads', async () => {
    const lake = await dataLakeRepository.create(gatedLake('expired', 'owner'));
    await dataLakeAccessGrantRepository.upsertGrant({
      dataLakeId: lake.id,
      principalType: 'user',
      principalId: 'ex-curator',
      role: 'curator',
      grantedByUserId: 'owner',
      expiresAt: new Date(Date.now() - 60_000),
    });

    expect(await browsableSlugs('ex-curator')).toEqual([]);
    expect(await retrievableSlugs('ex-curator')).toEqual([]);
  });
});

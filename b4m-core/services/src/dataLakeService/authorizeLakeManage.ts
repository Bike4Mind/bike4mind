import type { IDataLakeAccessGrantRepository, IDataLakeDocument } from '@bike4mind/common';
import { canManageLake, type LakeGrant, type ManageActor } from './manageRule';
import { isFallbackLake } from './assertLakeAccess';

/**
 * The grant-read slice a manage decision needs. `dataLakeAccessGrants` is OPTIONAL: when a caller
 * does not wire it, grant resolution degrades to `[]`, so management falls back to the
 * createdByUserId owner + the org-admin rung (from `actor.administeredOrgIds`). The primary
 * lake-management services require it in their own adapter types so their endpoints must wire it;
 * high-fan-in file-creation paths that only ever apply their own/hardcoded tags leave it out.
 */
export type GrantReadAdapter = {
  db: { dataLakeAccessGrants?: Pick<IDataLakeAccessGrantRepository, 'listByLake'> };
};

/**
 * A lake's ACTIVE grants, reduced to the slice `canManageLake` consults. A fallback (hardcoded
 * registry) lake has no backing document and therefore no grants - short-circuit without a query,
 * mirroring `assertLakeGrantable`. Returns `[]` when no grant repo is wired (see GrantReadAdapter).
 * `asOf` defaults to now so lapsed grants are excluded from the decision (they remain in the
 * collection for the audit/membership view).
 */
export async function loadActiveLakeGrants(
  lake: Pick<IDataLakeDocument, 'id'>,
  { db }: GrantReadAdapter,
  asOf: Date = new Date()
): Promise<LakeGrant[]> {
  if (isFallbackLake(lake) || !db.dataLakeAccessGrants) return [];
  const grants = await db.dataLakeAccessGrants.listByLake(lake.id, { activeAsOf: asOf });
  return grants.map(g => ({ principalType: g.principalType, principalId: g.principalId, role: g.role }));
}

/**
 * Grant-aware management check: fetch the lake's active grants, then apply the pure `canManageLake`
 * rule. Every mutating service gate calls this instead of `canManageLake` directly, so curator /
 * transferred-owner / org grants are honored uniformly. Kept as a boolean (not an assert) so each
 * call site keeps its bespoke denial message.
 */
export async function resolveCanManageLake(
  lake: Pick<IDataLakeDocument, 'id' | 'createdByUserId' | 'organizationId'>,
  actor: ManageActor,
  adapters: GrantReadAdapter
): Promise<boolean> {
  const grants = await loadActiveLakeGrants(lake, adapters);
  return canManageLake(lake, actor, grants);
}

/** The batch-read slice a multi-lake gate loop needs. Optional for the same reason as GrantReadAdapter. */
export type BatchGrantReadAdapter = {
  db: { dataLakeAccessGrants?: Pick<IDataLakeAccessGrantRepository, 'listActiveByLakes'> };
};

/** Batched, memoized grant resolver for a gate loop over MANY lakes (one query per unprimed set). */
export interface LakeGrantResolver {
  /** Batch-fetch and cache grants for any of `lakes` not already cached. */
  prime(lakes: Pick<IDataLakeDocument, 'id'>[]): Promise<void>;
  /** The cached active grants for a lake id (empty when unprimed or ungranted). */
  get(lakeId: string): LakeGrant[];
}

/**
 * Grant resolver for services that gate a SET of lakes in one call (the tag-toggle prefix-arm
 * reconciliation). Avoids an N+1 by batching `prime` into a single `listActiveByLakes`, and caches
 * so a lake gated twice in one pass costs one round-trip. Ids not backed by a persisted grant simply
 * cache to `[]`, so a fallback (registry) lake resolves to no grants without a special case.
 */
export function makeLakeGrantResolver({ db }: BatchGrantReadAdapter): LakeGrantResolver {
  const cache = new Map<string, LakeGrant[]>();
  return {
    async prime(lakes) {
      if (!db.dataLakeAccessGrants) return;
      const missing = Array.from(new Set(lakes.map(l => l.id).filter(id => !cache.has(id))));
      if (missing.length === 0) return;
      // Seed empty first so an id with no grants is treated as primed, not refetched.
      for (const id of missing) cache.set(id, []);
      const grants = await db.dataLakeAccessGrants.listActiveByLakes(missing, { activeAsOf: new Date() });
      for (const grant of grants) {
        cache.get(grant.dataLakeId)?.push({
          principalType: grant.principalType,
          principalId: grant.principalId,
          role: grant.role,
        });
      }
    },
    get(lakeId) {
      return cache.get(lakeId) ?? [];
    },
  };
}

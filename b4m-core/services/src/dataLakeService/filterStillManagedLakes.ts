import type { IDataLakeAccessGrantRepository, IDataLakeDocument, IOrganizationRepository } from '@bike4mind/common';
import { canManageLake, type ManageActor } from './manageRule';
import { makeLakeGrantResolver } from './authorizeLakeManage';

/**
 * The reads a per-turn manage re-check needs. Both are OPTIONAL and both degrade CLOSED:
 * without the grant repo the curator, org-grant and transferred-owner rungs cannot pass, and
 * without the org repo the org-admin rung cannot. A caller that has not wired them therefore
 * narrows the admission rather than widening it - but it also revokes a legitimate maintainer,
 * so every path that populates `preauthorizedLakeIds` is expected to wire both.
 */
export interface ManageRecheckAdapter {
  dataLakeAccessGrants?: Pick<IDataLakeAccessGrantRepository, 'listActiveByLakes'>;
  /**
   * `Partial<Pick<...>>` rather than an optional whole-repo slice ON PURPOSE. Every adapter this
   * mixes into already declares `organizations` as a REQUIRED narrower Pick, and TypeScript reduces
   * `Required<A> & Optional<B>` on the same key to `A & B` - i.e. an optional slice here would make
   * `findIdsWithAdminRights` mandatory at every construction site of every context it touches.
   * A partial member keeps the mixin additive, at the cost of a runtime typeof guard below.
   */
  organizations?: Partial<Pick<IOrganizationRepository, 'findIdsWithAdminRights'>>;
}

/**
 * Re-applies the session-create manage gate to lakes admitted by `preauthorizedLakeIds`, so that
 * revoking someone's manage rights revokes the sessions they already created. Without this the
 * admission is authorized once and never revalidated: every other lake-read path in this codebase
 * re-derives access per turn, and this one would be the standing exception.
 *
 * MUST mirror pages/api/sessions/create.ts's `manageActor`: `isAdmin: false` (so "any platform
 * admin" is not a rung - the caller has to actually manage THIS lake) and `administeredOrgIds`
 * re-resolved from `findIdsWithAdminRights` rather than read off an AccessContext, which zeroes
 * that field for admin actors. A drift between the two gates would either admit someone the route
 * rejected or revoke someone it admitted.
 *
 * Costs two reads per call regardless of lake count: the grant resolver batches into one
 * `listActiveByLakes`, and the org-admin set is per-user. Deliberately not cached across calls -
 * a cache that outlived the turn would reintroduce exactly the staleness this exists to close.
 */
export async function filterStillManagedLakes(
  lakes: IDataLakeDocument[],
  actorUserId: string,
  db: ManageRecheckAdapter
): Promise<IDataLakeDocument[]> {
  if (lakes.length === 0) return lakes;

  const findAdminOrgIds = db.organizations?.findIdsWithAdminRights;
  const grantResolver = makeLakeGrantResolver({ db: { dataLakeAccessGrants: db.dataLakeAccessGrants } });
  const [administeredOrgIds] = await Promise.all([
    typeof findAdminOrgIds === 'function'
      ? findAdminOrgIds.call(db.organizations, actorUserId)
      : Promise.resolve<string[]>([]),
    grantResolver.prime(lakes),
  ]);

  const actor: ManageActor = { userId: actorUserId, isAdmin: false, administeredOrgIds };
  return lakes.filter(lake => canManageLake(lake, actor, grantResolver.get(lake.id)));
}

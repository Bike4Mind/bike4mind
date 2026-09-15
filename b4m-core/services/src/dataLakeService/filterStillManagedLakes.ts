import type { IDataLakeAccessGrantRepository, IDataLakeDocument, IOrganizationRepository } from '@bike4mind/common';
import { canManageLake, type ManageActor } from './manageRule';
import { makeLakeGrantResolver } from './authorizeLakeManage';

/**
 * The reads a per-turn manage re-check needs. Both are OPTIONAL and both degrade CLOSED: without
 * the org repo the org-admin rung cannot pass, and without the grant repo neither can the curator
 * and org-grant rungs - nor the owner rung, which is refused outright in that case rather than
 * falling back to the creator (see the creator-rung note in filterStillManagedLakes). A caller
 * that has not wired them therefore narrows the admission rather than widening it - but it also
 * revokes a legitimate maintainer, so every path that populates `preauthorizedLakeIds` is
 * expected to wire both.
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
  // The creator rung is the one rung that passes on ABSENT evidence: resolveEffectiveOwnerIds falls
  // back to `createdByUserId` when it sees no owner grant, and an ownership TRANSFER is exactly an
  // owner grant that never mutates that field - so with no grant repo wired a former owner would
  // still read as the effective owner, the one way this re-check could degrade OPEN. Blanking the
  // creator denies that rung alone: canManageLake's owner rung is guarded on the truthiness of the
  // field and already fails closed on a blank identity, so the shared rule needs no change, and
  // `organizationId` is carried through so the grant-free org-admin rung stays available.
  const trustCreatorRung = !!db.dataLakeAccessGrants;
  return lakes.filter(lake =>
    canManageLake(
      trustCreatorRung ? lake : { createdByUserId: '', organizationId: lake.organizationId },
      actor,
      grantResolver.get(lake.id)
    )
  );
}

import type {
  AccessContext,
  IDataLakeAccessGrant,
  IDataLakeDocument,
  LakeAuditPrincipal,
  LakeManageRung,
} from '@bike4mind/common';
import { normalizeId } from '@bike4mind/utils';

/**
 * The acting principal for a write/manage decision - resolved from auth, never the body.
 * `administeredOrgIds` is the set of orgs the actor holds admin rights in, pre-resolved app-side
 * (see AccessContext.administeredOrgIds); it powers the org-manageable rung. Optional so a caller
 * that has not threaded it yet still compiles - the org rung simply does not fire (back-compat).
 */
export type ManageActor = Pick<AccessContext, 'userId' | 'isAdmin' | 'administeredOrgIds'> & {
  /**
   * Who to ATTRIBUTE an audited write to, when that is not simply `userId`. Set by a route that
   * accepts API-key auth: `baseApi()` admits either a session or a `b4m_live_` key, so `userId`
   * alone conflates a human editing in the app with a key acting on their behalf, and an audit row
   * that named the human for a key-driven change would be wrong in the one field it exists to get
   * right. Derived at the route from `resolveAuditPrincipal` - the SAME helper the read side uses,
   * so the two halves of the trail describe a principal identically.
   *
   * Optional and additive: absent, `recordLakeConfigChange` falls back to deriving the principal
   * from `userId`, which is correct for a session write and for a script with no principal at all.
   * It rides on the actor rather than on each service's params so no config-write service signature
   * has to change - they already forward `actor` to the audit call.
   */
  auditPrincipal?: LakeAuditPrincipal;
};

/**
 * The slice of a lake's access grant a manage decision needs. The caller pre-fetches the lake's
 * ACTIVE (expiry-filtered) grants and passes them in, keeping this rule pure/sync/testable - the
 * same seam as pre-resolved `entitlementKeys`.
 */
export type LakeGrant = Pick<IDataLakeAccessGrant, 'principalType' | 'principalId' | 'role'>;

/**
 * Truthy-guarded CREATOR match - the immutable provenance identity, NOT necessarily the current
 * owner. `createdByUserId` never changes (it anchors the membership prefix arm); ownership is
 * transferred by an owner-role grant that supersedes it (see `resolveEffectiveOwnerIds`). Use this
 * only where creator provenance is genuinely wanted (prefix-collision scope, the owner-exemption in
 * getDynamicDataLakeTags); use `isEffectiveOwner` for an ownership decision.
 *
 * The truthiness guard fails closed on a blank identity: without it, a lake with no `createdByUserId`
 * (the synthetic fallback document) would match an actor with no `userId` (`'' === ''`).
 */
export function isLakeCreator(
  lake: Pick<IDataLakeDocument, 'createdByUserId'>,
  actor: Pick<ManageActor, 'userId'>
): boolean {
  return !!actor.userId && !!lake.createdByUserId && lake.createdByUserId === actor.userId;
}

/**
 * May this actor DESTROY the lake's memory profile? Deliberately NARROWER than `canManageLake`.
 *
 * Reading a lake is org-shared and managing one is grant-aware, but an irreversible crypto-shred of
 * what the whole org reads is effective-owner-or-platform-admin only. Curator and org-admin rungs may
 * build the profile and may not erase it. Following effective ownership ensures a transfer also moves
 * the responsibility for deleting the profile away from the former creator.
 *
 * Named and exported so the API gate and the UI's button flag consult ONE predicate. They were two
 * open-coded expressions - the button rendered on the grant-aware `canManage` while the endpoint
 * called `canManageLake` with neither grants nor `organizationId`, which silently reduces it to this
 * - so curator-grant holders, org admins and transferred owners were all offered a button the
 * endpoint answered with a 403.
 *
 * `grants` must be the lake's active, pre-fetched grants. Requiring the snapshot makes an omitted
 * transfer state a compile error instead of silently restoring the immutable creator's authority.
 */
export function canShredLakeMemory(
  lake: Pick<IDataLakeDocument, 'createdByUserId'>,
  actor: Pick<ManageActor, 'userId' | 'isAdmin'>,
  grants: readonly LakeGrant[]
): boolean {
  if (actor.isAdmin) return true;
  return isEffectiveOwner(lake, actor, grants);
}

/**
 * The lake's EFFECTIVE owner ids: the holders of an `owner`-role USER grant if any exist, otherwise
 * the immutable creator. This is the one place "who owns this lake" is resolved, so a transfer
 * (which upserts an owner grant) supersedes the creator everywhere without ever mutating
 * `createdByUserId`. Existing lakes carry no grants, so they resolve to `[createdByUserId]` exactly
 * as before - no backfill needed.
 *
 * CAUTION for callers that EXPIRE an owner grant: the fallback makes that a RE-ASSIGNMENT, not a
 * removal. Expiring the last active owner row on a lake that was transferred away from its creator
 * hands ownership back to that creator - who may have been deliberately moved off it. There is no
 * "nobody owns this" state to land in, by design (it would make a lake unadministrable), so a
 * caller ending an owner's tenure must decide who takes it: see `lapseDepartedMemberLakeAccess`
 * phase 2, which names a successor for exactly this reason, and `transferLakeOwnership`, which
 * demotes rather than expires. Accepted, not solved, for the transferred-away case: the departing
 * owner's lapse can still resolve back to the original creator.
 */
export function resolveEffectiveOwnerIds(
  lake: Pick<IDataLakeDocument, 'createdByUserId'>,
  grants: readonly LakeGrant[] = []
): string[] {
  const ownerUserIds = grants
    .filter(g => g.principalType === 'user' && g.role === 'owner' && !!g.principalId)
    .map(g => g.principalId);
  if (ownerUserIds.length > 0) return Array.from(new Set(ownerUserIds));
  return lake.createdByUserId ? [lake.createdByUserId] : [];
}

/**
 * True when the actor is an effective owner (grant-superseded creator). Deliberately excludes the
 * platform-admin bypass and the curator/org rungs - it is the "the OWNER, not merely a manager"
 * predicate used at owner-only gates (the visibility expose gate, the `isOwn` display label).
 */
export function isEffectiveOwner(
  lake: Pick<IDataLakeDocument, 'createdByUserId'>,
  actor: Pick<ManageActor, 'userId'>,
  grants: readonly LakeGrant[] = []
): boolean {
  return !!actor.userId && resolveEffectiveOwnerIds(lake, grants).includes(actor.userId);
}

/**
 * Is an ORGANIZATION-principal grant contained to the lake it is granted on? True for an org-less
 * lake (nothing to cross) or when the granted org IS the lake's own org; false for a lake belonging
 * to a DIFFERENT org. Both sides are normalized because `lake.organizationId` may arrive as an
 * ObjectId while `principalId` is always a string.
 *
 * Factored out rather than inlined twice: `canManageLake` and `resolveLakeManageRung` must agree on
 * the org-grant rung, and a shared conjunct cannot drift between them.
 *
 * Org membership never crosses orgs (epic decision 12). The read arm enforces that at grant-WRITE
 * time (see resolveReadGrant's sync note); the MANAGE rung enforces it here, at decision time, so an
 * admin of orgA holding an org grant cannot manage - and therefore cannot read - an orgB lake.
 */
function isGrantOrgContained(grant: LakeGrant, lakeOrg: string | undefined): boolean {
  return !lakeOrg || normalizeId(grant.principalId) === lakeOrg;
}

/**
 * The single WRITE/MANAGE decision for a lake, in ascending rungs (none weakens the gate; each only
 * ADDS a manager):
 *   1. platform admin;
 *   2. effective owner - an `owner`-grant holder, or the creator when no owner grant exists;
 *   3. a `curator` USER grant - full routine management (add/remove/reprocess members) short of
 *      ownership transfer and the visibility expose gate, which stay effective-owner-only;
 *   4. an admin of the lake's org (`lake.organizationId in actor.administeredOrgIds`) - the
 *      org-manageable rung: org lakes survive their creator because org admins manage them by role;
 *   5. an `owner`/`curator` ORG grant for an org the actor administers, where that org is the
 *      lake's OWN org (or the lake has none) - an org grant never reaches across orgs.
 *
 * Deliberately narrower than `canAccessLake` (read): a tag/entitlement/org-READ grant lets a member
 * read a lake but not write into it. `canAccessLake` calls THIS first, so every rung here also
 * grants read - correct, a manager can always read what they manage.
 *
 * `grants` is the lake's active grant set, pre-fetched by the caller; omitted -> `[]`, so a caller
 * that has not threaded grants yet still gets rungs 1, 2 (via creator) and 4.
 *
 * WRITE-TIME RESIDUAL. Every manage write decides from a grant read and then writes, so a revoke can
 * commit in between. The rule, rather than a list that drifts: a manage write is serialized against
 * a revoke ONLY when it writes the lake DOCUMENT inside `withTransaction` with its gate inside the
 * callback (see the SERIALIZATION note on `grantLakeAccess`). Today that is the grants door, the lake
 * PUT, visibility, promote, demote and the cleanup claim (its sweep runs later and re-gates); the
 * ownership apply (`acceptLakeOwnershipOffer` -> `applyLakeOwnershipTransfer`) is a transactional
 * lake-doc writer too, gated by transfer authority rather than this rule. A write whose own target is
 * another collection joins by touching the lake last (`IDataLakeRepository.touchIfStable`): file add
 * and remove (internal and v1 doors) and tags, research config create/update/delete, proposal
 * decline/restore, finding resolve/assign, batch create and taxonomy dismiss. Inside that transaction a
 * service's best-effort write (audit row, restore record, stats) is no longer best-effort: its failure
 * aborts the transaction and fails the request. Any lake-doc write outside it (an ingestion worker's
 * stats) also collides, so a manage write during a busy upload can exhaust its retries.
 *
 * Every other manage-gated write is gated once per request, and a revoke committing after that gate
 * does not abort it:
 *   - the archive/unarchive/delete/restore cascades, deliberately: each runs its claim and sweep in
 *     one call, so a transaction would span the whole sweep, and re-checking after the claim would
 *     strand the lake mid-status;
 *   - the writes with an external or long step - proposal approve, research run start, taxonomy
 *     apply/reanalyze, converge, rechunk, lake memory, inconsistency detection, finding belief -
 *     membership decisions, which can recompute stats once per removed duplicate, and corpus
 *     actions, whose merge audits a partial result that a rollback would contradict;
 *   - the toggle-tags join door (`fabFileService.toggleTags`), which reaches a lake from the file side;
 *   - any of the above on a lake in a transitional status, which `touchIfStable` skips.
 *
 * A departure lapse collides too when the lapsed grant could manage (`lapseDepartedMemberLakeAccess`
 * phase 1 touches the lake for an owner/curator grant, and like the writers skips a transitional
 * lake). Loss of an org role collides with nothing,
 * since `administeredOrgIds`/`isAdmin` are request snapshots - current-membership enforcement for the
 * org rungs is a separate, known gap (the snapshot is built in `toAccessContext.ts`).
 */
export function canManageLake(
  lake: Pick<IDataLakeDocument, 'createdByUserId' | 'organizationId'>,
  actor: ManageActor,
  grants: readonly LakeGrant[] = []
): boolean {
  if (actor.isAdmin) return true;
  if (!actor.userId) return false;

  if (isEffectiveOwner(lake, actor, grants)) return true;

  if (grants.some(g => g.principalType === 'user' && g.principalId === actor.userId && g.role === 'curator')) {
    return true;
  }

  const administeredOrgIds = actor.administeredOrgIds ?? [];
  const lakeOrg = normalizeId(lake.organizationId);
  if (lakeOrg && administeredOrgIds.includes(lakeOrg)) return true;

  return grants.some(
    g =>
      g.principalType === 'organization' &&
      (g.role === 'owner' || g.role === 'curator') &&
      administeredOrgIds.includes(g.principalId) &&
      isGrantOrgContained(g, lakeOrg)
  );
}

/**
 * WHICH rung of `canManageLake` authorized this actor, for the config-change audit trail. Returns
 * `null` for an actor who cannot manage the lake at all, so it is exactly `canManageLake` with the
 * winning rung named instead of collapsed to `true`.
 *
 * Reports the rungs in `canManageLake`'s order with ONE deliberate departure: `platform-admin` is
 * checked LAST, so it is reported only when no lake-side relationship of the actor's own would have
 * authorized the write. The rung feeds a history surface that renders `platform-admin` as a warning
 * ("somebody outside this lake's own people changed it"), so reporting the most privileged
 * applicable rung fired that warning on a dual-role account's routine edits to a lake it owns -
 * technically true, but a false alarm on the one surface whose whole purpose is trust. Ownership,
 * curatorship and the org rungs are standing relationships to THIS lake and are the more
 * informative answer whenever one of them applies.
 *
 * MUST stay in sync with `canManageLake` above; a test pins agreement across both directions
 * (a rung implies manage, and no-rung implies no-manage), so a new rung added there without one
 * here fails rather than silently recording every write under an older rung. The reordering is safe
 * for that agreement precisely because it only changes WHICH of several granting rungs is named.
 */
export function resolveLakeManageRung(
  lake: Pick<IDataLakeDocument, 'createdByUserId' | 'organizationId'>,
  actor: ManageActor,
  grants: readonly LakeGrant[] = []
): LakeManageRung | null {
  // A principal-less actor has no lake-side relationship to find, so admin is the only answer left.
  if (!actor.userId) return actor.isAdmin ? 'platform-admin' : null;

  // Split where isEffectiveOwner does not: an `owner` USER grant supersedes the creator, so the two
  // arms answer different questions after a transfer (who it was moved to vs. the original author
  // acting on a lake that has never been transferred).
  if (grants.some(g => g.principalType === 'user' && g.principalId === actor.userId && g.role === 'owner')) {
    return 'grant-owner';
  }
  if (isEffectiveOwner(lake, actor, grants)) return 'creator';

  if (grants.some(g => g.principalType === 'user' && g.principalId === actor.userId && g.role === 'curator')) {
    return 'grant-curator';
  }

  const administeredOrgIds = actor.administeredOrgIds ?? [];
  const lakeOrg = normalizeId(lake.organizationId);
  if (lakeOrg && administeredOrgIds.includes(lakeOrg)) return 'org-admin';

  const hasOrgGrant = grants.some(
    g =>
      g.principalType === 'organization' &&
      (g.role === 'owner' || g.role === 'curator') &&
      administeredOrgIds.includes(g.principalId) &&
      isGrantOrgContained(g, lakeOrg)
  );
  if (hasOrgGrant) return 'org-grant';

  return actor.isAdmin ? 'platform-admin' : null;
}

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
 * The lake's EFFECTIVE owner ids: the holders of an `owner`-role USER grant if any exist, otherwise
 * the immutable creator. This is the one place "who owns this lake" is resolved, so a transfer
 * (which upserts an owner grant) supersedes the creator everywhere without ever mutating
 * `createdByUserId`. Existing lakes carry no grants, so they resolve to `[createdByUserId]` exactly
 * as before - no backfill needed.
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
 * The single WRITE/MANAGE decision for a lake, in ascending rungs (none weakens the gate; each only
 * ADDS a manager):
 *   1. platform admin;
 *   2. effective owner - an `owner`-grant holder, or the creator when no owner grant exists;
 *   3. a `curator` USER grant - full routine management (add/remove/reprocess members) short of
 *      ownership transfer and the visibility expose gate, which stay effective-owner-only;
 *   4. an admin of the lake's org (`lake.organizationId in actor.administeredOrgIds`) - the
 *      org-manageable rung: org lakes survive their creator because org admins manage them by role;
 *   5. an `owner`/`curator` ORG grant for an org the actor administers.
 *
 * Deliberately narrower than `canAccessLake` (read): a tag/entitlement/org-READ grant lets a member
 * read a lake but not write into it. `canAccessLake` calls THIS first, so every rung here also
 * grants read - correct, a manager can always read what they manage.
 *
 * `grants` is the lake's active grant set, pre-fetched by the caller; omitted -> `[]`, so a caller
 * that has not threaded grants yet still gets rungs 1, 2 (via creator) and 4.
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
      administeredOrgIds.includes(g.principalId)
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
      administeredOrgIds.includes(g.principalId)
  );
  if (hasOrgGrant) return 'org-grant';

  return actor.isAdmin ? 'platform-admin' : null;
}

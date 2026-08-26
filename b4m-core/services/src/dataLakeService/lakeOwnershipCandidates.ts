import type {
  AccessContext,
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
  IOrganizationDocument,
  IOrganizationRepository,
  IUserRepository,
  LakeOwnershipCandidateList,
} from '@bike4mind/common';
import { normalizeId } from '@bike4mind/utils';
import { isEffectiveOwner, resolveEffectiveOwnerIds, type LakeGrant, type ManageActor } from './manageRule';
import { loadActiveLakeGrants } from './authorizeLakeManage';
import { isFallbackLake } from './assertLakeAccess';

/**
 * Every user id the owning organization makes eligible to RECEIVE ownership: the billing owner, the
 * appointed org admins, and everyone on the org's `users[]` ACL.
 *
 * Deliberately UNFILTERED by share permission, and therefore deliberately WIDER than the read gate's
 * admitted set (`ORG_MEMBER_PERMISSIONS` in assembleLakeAccessView, which is the org channel's
 * `holderCount`). The two answer different questions and must not be conflated: the channel count is
 * "who can already read this", while this is "who may be handed the lake" - and a new owner does not
 * need pre-existing read access, since owning it grants that. The org member count shown in the
 * access view being smaller than this list is expected, not a bug.
 *
 * This is the ONE enumeration of that set. `isOrgOwnershipCandidate` is derived from it rather than
 * written as a parallel predicate, so the picker can never offer a user the transfer would reject
 * (or hide one it would accept) - the drift that a second, hand-kept copy invites.
 */
export function listOrgOwnershipCandidateIds(
  org: Pick<IOrganizationDocument, 'userId' | 'adminUserIds' | 'users'>
): string[] {
  const ids = [org.userId, ...(org.adminUserIds ?? []), ...(org.users ?? []).map(member => member.userId)];
  return Array.from(new Set(ids.filter(Boolean)));
}

/** Whether `userId` may receive ownership of a lake owned by `org`. See the enumeration above. */
export function isOrgOwnershipCandidate(
  org: Pick<IOrganizationDocument, 'userId' | 'adminUserIds' | 'users'>,
  userId: string
): boolean {
  return !!userId && listOrgOwnershipCandidateIds(org).includes(userId);
}

/**
 * The acting principal for a transfer decision: `ManageActor` plus the actor's CURRENT org
 * membership, which the transfer rule needs and `canManageLake` does not.
 *
 * `organizationIds` is deliberately REQUIRED rather than optional-with-a-fallback: an absent
 * membership set would silently re-open the stale-grant path below, and every caller already holds a
 * full `AccessContext` (the routes build one via `toAccessContext`), so requiring it costs nothing
 * and turns a forgotten thread into a compile error instead of a quiet widening.
 */
export type LakeTransferActor = ManageActor & Pick<AccessContext, 'organizationIds'>;

/** Who, if anyone, the actor is authorized to transfer a lake as - and by which rung. */
export interface LakeTransferAuthority {
  allowed: boolean;
  /**
   * Whether the actor is an effective owner (grant-superseded creator). Exposed rather than kept
   * internal because it is an AUTHORIZATION fact callers must not re-derive: the audit trail records
   * which rung authorized a transfer, and re-deciding that separately from the gate that allowed it
   * is how a record ends up naming an authority the gate never used.
   */
  isOwner: boolean;
  /**
   * True when the ONLY thing authorizing the actor is the org-admin rung - not ownership, not
   * platform admin. Such an actor may reassign the lake to another member but not to themselves;
   * see the consent guard in `transferLakeOwnership`.
   */
  viaOrgAdminOnly: boolean;
}

/**
 * The transfer authorization rule, deliberately NARROWER than `canManageLake`: a platform admin, the
 * current effective owner, or an admin of the lake's own org (the orphaned-creator succession path).
 * A curator manages but does not own, so cannot hand ownership away.
 *
 * On an ORG lake every rung additionally requires the actor to still BELONG to that org. Grants are
 * not revoked when someone leaves an organization (the only grant-removal path in the tree is lake
 * deletion), so an owner grant outlives the membership that motivated it - and without this check
 * that stale grant would keep answering "yes" here, which the candidate listing turns into a live
 * read of the org's present-day roster with work emails attached. Org-admin rights count as
 * membership on their own: an appointed admin (`adminUserIds`) or team manager need not sit on the
 * org's `users[]` ACL, so requiring the ACL alone would close the succession path this rule exists
 * for. A platform admin is exempt (global superuser), and a personal lake has no org to belong to.
 *
 * Pure and sync over pre-fetched active grants, so the write path (`transferLakeOwnership`), the
 * candidate listing, and the access view's viewer-capability flag all decide from one rule instead of
 * three. A fallback (hardcoded registry) lake is never transferable - it has no document to hang an
 * owner grant on (`assertLakeGrantable`), so a surface that offered the action would only ever 400.
 */
export function resolveLakeTransferAuthority(
  lake: Pick<IDataLakeDocument, 'id' | 'createdByUserId' | 'organizationId'>,
  actor: LakeTransferActor,
  grants: readonly LakeGrant[] = []
): LakeTransferAuthority {
  if (isFallbackLake(lake)) return { allowed: false, isOwner: false, viaOrgAdminOnly: false };
  const isOwner = isEffectiveOwner(lake, actor, grants);
  const lakeOrg = normalizeId(lake.organizationId);
  const isOrgAdminOfLake = !!lakeOrg && (actor.administeredOrgIds ?? []).includes(lakeOrg);
  const inLakeOrg = !lakeOrg || isOrgAdminOfLake || (actor.organizationIds ?? []).includes(lakeOrg);
  return {
    allowed: !!actor.isAdmin || (inLakeOrg && (isOwner || isOrgAdminOfLake)),
    isOwner,
    viaOrgAdminOnly: !actor.isAdmin && !isOwner && isOrgAdminOfLake,
  };
}

export interface ListLakeOwnershipCandidatesAdapters {
  db: {
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
    users: Pick<IUserRepository, 'findByIds'>;
    organizations: Pick<IOrganizationRepository, 'findById'>;
  };
}

/**
 * Who this actor may hand a lake to - the option set behind the transfer-ownership picker.
 *
 * Only ORG-scoped lakes enumerate. A personal lake has no membership relation to scope the question,
 * so listing candidates would mean a global user search - a user-enumeration surface this
 * manager-facing view should not open. It returns `scope: 'personal'` with no candidates, and the UI
 * says so; the complete path is to move the lake into an organization first (lake Settings ->
 * Visibility -> Organization). The API itself stays broader, so an org-less transfer remains possible
 * for a caller that already knows the target user id.
 *
 * Excluded from the list, both for reasons the picker would otherwise misrepresent:
 *  - current effective owners - transferring to them is a no-op;
 *  - the actor themselves when authorized solely as an org admin - the consent guard in
 *    `transferLakeOwnership` refuses that, so offering it would be an option that always fails.
 *
 * This function owns its OWN gate and does not assume the caller applied one: the route ahead of it
 * applies only the not-found-style READ gate (`assertLakeAccess`), never `canManageLake`, so the
 * narrower transfer rule below is the only thing standing between a mere reader and a list of
 * teammates' work emails. It returns an empty list rather than throwing when that rule does not hold,
 * so a caller who may read but not transfer simply sees no picker.
 */
export async function listLakeOwnershipCandidates(
  lake: Pick<
    IDataLakeDocument,
    'id' | 'createdByUserId' | 'organizationId' | 'requiredUserTag' | 'requiredEntitlement'
  >,
  actor: LakeTransferActor,
  { db }: ListLakeOwnershipCandidatesAdapters
): Promise<LakeOwnershipCandidateList> {
  const lakeOrg = normalizeId(lake.organizationId);
  const scope = lakeOrg ? 'organization' : 'personal';
  // Carried on every shape the picker actually renders from (org-scoped and authorized), so the
  // confirmation can say that ownership bypasses this gate - see `LakeOwnershipCandidateList.gate`.
  // The refused and personal shapes below omit it: neither offers an action for it to qualify.
  const gate =
    lake.requiredUserTag || lake.requiredEntitlement
      ? {
          ...(lake.requiredUserTag ? { requiredUserTag: lake.requiredUserTag } : {}),
          ...(lake.requiredEntitlement ? { requiredEntitlement: lake.requiredEntitlement } : {}),
        }
      : undefined;

  const grants = await loadActiveLakeGrants(lake, { db });
  const authority = resolveLakeTransferAuthority(lake, actor, grants);
  if (!authority.allowed || !lakeOrg) {
    return { scope, candidates: [] };
  }

  const org = await db.organizations.findById(lakeOrg).catch(() => null);
  if (!org) {
    return { scope, candidates: [] };
  }

  const excluded = new Set<string>(resolveEffectiveOwnerIds(lake, grants));
  if (authority.viaOrgAdminOnly && actor.userId) excluded.add(actor.userId);
  const candidateIds = listOrgOwnershipCandidateIds(org).filter(id => !excluded.has(id));
  if (candidateIds.length === 0) {
    return { scope, candidates: [], organizationName: org.name, ...(gate ? { gate } : {}) };
  }

  // Email is carried here, unlike the access view's `userDisplayName` (which withholds it on
  // purpose): that view resolves arbitrary cross-tenant principals, whereas every id here is a
  // member of the lake's own organization, and an email is what distinguishes two teammates who
  // share a display name in a picker that hands over ownership.
  const users = await db.users.findByIds(candidateIds);
  const candidates = users
    // `email` is nullable on the user document; normalize to absent so the type means "unknown", not null.
    .map(user => ({ userId: user.id, name: user.name || user.username || undefined, email: user.email ?? undefined }))
    .sort((a, b) => (a.name ?? a.email ?? a.userId).localeCompare(b.name ?? b.email ?? b.userId));

  return { scope, candidates, organizationName: org.name, ...(gate ? { gate } : {}) };
}

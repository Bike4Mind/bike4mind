import type {
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
 * Pure and sync over pre-fetched active grants, so the write path (`transferLakeOwnership`), the
 * candidate listing, and the access view's viewer-capability flag all decide from one rule instead of
 * three. A fallback (hardcoded registry) lake is never transferable - it has no document to hang an
 * owner grant on (`assertLakeGrantable`), so a surface that offered the action would only ever 400.
 */
export function resolveLakeTransferAuthority(
  lake: Pick<IDataLakeDocument, 'id' | 'createdByUserId' | 'organizationId'>,
  actor: ManageActor,
  grants: readonly LakeGrant[] = []
): LakeTransferAuthority {
  if (isFallbackLake(lake)) return { allowed: false, isOwner: false, viaOrgAdminOnly: false };
  const isOwner = isEffectiveOwner(lake, actor, grants);
  const lakeOrg = normalizeId(lake.organizationId);
  const isOrgAdminOfLake = !!lakeOrg && (actor.administeredOrgIds ?? []).includes(lakeOrg);
  return {
    allowed: !!actor.isAdmin || isOwner || isOrgAdminOfLake,
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
 * The CALLER owns the read gate (the actor must already be able to manage the lake); this applies the
 * narrower transfer rule on top and returns an empty list rather than throwing when it does not hold.
 */
export async function listLakeOwnershipCandidates(
  lake: Pick<IDataLakeDocument, 'id' | 'createdByUserId' | 'organizationId'>,
  actor: ManageActor,
  { db }: ListLakeOwnershipCandidatesAdapters
): Promise<LakeOwnershipCandidateList> {
  const lakeOrg = normalizeId(lake.organizationId);
  const scope = lakeOrg ? 'organization' : 'personal';

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
    return { scope, candidates: [], organizationName: org.name };
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

  return { scope, candidates, organizationName: org.name };
}

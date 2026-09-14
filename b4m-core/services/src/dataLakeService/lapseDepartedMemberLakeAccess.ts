import type { IDataLakeAccessGrantRepository, IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { grantChange, ownershipChange } from './diffLakeConfig';
import { resolveEffectiveOwnerIds, type LakeGrant, type ManageActor } from './manageRule';
import { recordLakeConfigChange, type LakeConfigAuditAdapters } from './recordLakeConfigChange';

export interface LapseDepartedMemberLakeAccessAdapters extends LakeConfigAuditAdapters {
  // The event repo is REQUIRED here, matching `transferLakeOwnership`: the only callers are the two
  // org-departure routes, so nothing is spared by making it optional and a route that forgot to
  // wire it would go dark silently - the one failure mode an access-revocation audit must not have.
  db: LakeConfigAuditAdapters['db'] & {
    lakeConfigChangeEvents: NonNullable<LakeConfigAuditAdapters['db']['lakeConfigChangeEvents']>;
    dataLakes: Pick<IDataLakeRepository, 'findByOrganizationId'>;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByPrincipal' | 'listActiveByLakes' | 'upsertGrant'>;
  };
}

export interface LapseDepartedMemberLakeAccessResult {
  /** Lakes where the departing member's own grant lapsed. */
  lapsedLakeIds: string[];
  /** Lakes whose ownership passed to the org's billing owner because their creator left. */
  succeededLakeIds: string[];
}

/**
 * Who to attribute the lapse to in the audit trail: the admin who removed the member, or the member
 * themselves on a self-service leave.
 *
 * Deliberately NOT a full `ManageActor`. The org services that call this hold an `IUserDocument` and
 * no membership set, and a `ManageActor` they synthesised would carry an `organizationIds` that no
 * authorization ever resolved - a field that looks like an input and is not one. Narrowing the
 * parameter to the two fields the audit actually reads makes that unstateable.
 */
export type LakeAccessLapseTrigger = Pick<ManageActor, 'userId' | 'auditPrincipal'>;

/** The departing member's organization, as much of it as this decision needs. */
export interface LapsingOrganization {
  id: string;
  /** The billing owner - the successor for a lake whose creator is the departing member. */
  userId: string;
}

/**
 * End a departing member's data-lake access on the lakes of the org they are leaving.
 *
 * Membership removal and grant lifetime were two independent systems: nothing ended a member's
 * grant rows on an org's lakes when they stopped being a member of that org. Grants carry no
 * membership qualifier, so a role held on an org lake (`owner`/`curator`/`reader`) outlived the
 * membership it was issued for. This is the lifecycle step that was missing.
 *
 * TWO phases, because a grant is not the only way ownership survives a departure:
 *  1. lapse the member's own `user` grants on this org's lakes;
 *  2. for a lake the member CREATED, pass ownership to the org's billing owner - otherwise phase 1
 *     merely drops them one rung into `resolveEffectiveOwnerIds`' creator fallback, which resolves
 *     ownership straight back to them.
 *
 * Phase 2 is why there is no "member holds no grants, return early" shortcut: a creator who was
 * never granted anything holds no row to find, and that is precisely the case the fallback covers.
 *
 * Scoped to `user`-principal grants on lakes of the org BEING LEFT, which is what keeps it
 * compatible with the deliberate cross-org grant: a curator who was never a member of this org
 * triggers no departure here, and an `organization`-principal grant describes the org rather than
 * the person, so neither is touched.
 *
 * KNOWN LIMITATION, not introduced here: when the departing member holds the owner grant on a lake
 * somebody ELSE created, phase 1 lapses it and ownership falls back to that creator - who may
 * themselves have departed before this step existed. Reconciling those is a separate, historical
 * concern; this path creates no such rows itself.
 */
export async function lapseDepartedMemberLakeAccess(
  departedUserId: string,
  organization: LapsingOrganization,
  triggeredBy: LakeAccessLapseTrigger,
  adapters: LapseDepartedMemberLakeAccessAdapters,
  now: Date = new Date()
): Promise<LapseDepartedMemberLakeAccessResult> {
  const { db, logger } = adapters;

  const orgLakes = await db.dataLakes.findByOrganizationId(organization.id);
  if (orgLakes.length === 0) return { lapsedLakeIds: [], succeededLakeIds: [] };

  const audit = (
    lake: IDataLakeDocument,
    action: 'revoke-access' | 'membership-succession',
    changes: ReturnType<typeof grantChange>[]
  ) =>
    recordLakeConfigChange(
      {
        // The audit row wants a PRINCIPAL (who caused this), not an AUTHORITY (what allowed it):
        // no lake-side rung did, which is why `system` is stamped rather than resolved. The other
        // `ManageActor` fields are inert, and provably so rather than by convention - with no
        // grants, no admin flag and no administered orgs, `resolveLakeManageRung` returns null and
        // `recordLakeConfigChange` falls through to this same `system`.
        actor: { ...triggeredBy, isAdmin: false, administeredOrgIds: [] },
        lake,
        action,
        manageRung: 'system',
        changes: changes.filter(change => change !== null),
      },
      { db, logger }
    );

  const lapsedLakeIds = await lapseOwnGrants(departedUserId, orgLakes, db, audit, now);
  const succeededLakeIds = await passOnCreatedLakes(
    departedUserId,
    organization,
    orgLakes,
    db,
    audit,
    triggeredBy,
    now
  );

  return { lapsedLakeIds, succeededLakeIds };
}

type AuditFn = (
  lake: IDataLakeDocument,
  action: 'revoke-access' | 'membership-succession',
  changes: ReturnType<typeof grantChange>[]
) => Promise<void>;
type Db = LapseDepartedMemberLakeAccessAdapters['db'];

/**
 * Phase 1: expire, rather than delete, every `user` grant the departing member holds on this org's
 * lakes.
 *
 * EXPIRES because `expiresAt` is the documented lapse mechanism (see `DataLakeAccessGrant.expiresAt`:
 * lapsed rows are deliberately not swept, so the owner-facing membership view and the audit trail can
 * still render them). The row plus its bumped `updatedAt` is what lets an operator answer "when did
 * this access end, and what was it" - a hard delete answers neither.
 *
 * Unlike the manual `revokeLakeAccess` door - which refuses an `owner` grant outright, because
 * dropping one there would silently un-transfer a lake through a door that never named a new owner -
 * this path DOES lapse an owner grant, and must: leaving it would keep a departed member's access
 * alive. Phase 2 is what makes that safe, by naming the successor the manual door could not.
 */
async function lapseOwnGrants(
  departedUserId: string,
  orgLakes: IDataLakeDocument[],
  db: Db,
  audit: AuditFn,
  now: Date
): Promise<string[]> {
  const held = await db.dataLakeAccessGrants.listByPrincipal('user', departedUserId, { activeAsOf: now });
  const orgLakesById = new Map(orgLakes.map(lake => [lake.id, lake]));
  const lapsing = held.filter(grant => orgLakesById.has(grant.dataLakeId));

  // Sequential, not Promise.all: both callers run inside `withTransaction`, and the ambient session
  // a Mongo transaction carries does not accept concurrent operations.
  for (const grant of lapsing) {
    await db.dataLakeAccessGrants.upsertGrant({ ...grant, expiresAt: now });
    // Role on BOTH sides of the diff (rather than `undefined`, as the manual revoke door passes):
    // what moved is the expiry, so the row reads as "this access lapsed" and not "this grant was
    // deleted" - the distinction the expire-not-delete choice exists to preserve.
    await audit(orgLakesById.get(grant.dataLakeId)!, 'revoke-access', [
      grantChange('user', grant.principalId, grant.role, grant.role, grant.expiresAt ?? null, now),
    ]);
  }

  return lapsing.map(grant => grant.dataLakeId);
}

/**
 * Phase 2: for each lake the departing member CREATED and nobody else owns, mint an `owner` grant
 * for the org's billing owner, so `resolveEffectiveOwnerIds` stops resolving to someone who left.
 *
 * The billing owner (`organization.userId`) is the successor because it is the only always-present,
 * unique, deterministic answer: `managerId` is nullable and `adminUserIds` may be empty and carries
 * no meaningful order. It grants no new capability - `canManageLake`'s org rung already lets an org
 * admin manage every lake scoped to that org, and the billing owner is implicitly one - so this
 * relocates ownership off a departed person rather than handing anybody reach they lacked.
 */
async function passOnCreatedLakes(
  departedUserId: string,
  organization: LapsingOrganization,
  orgLakes: IDataLakeDocument[],
  db: Db,
  audit: AuditFn,
  triggeredBy: LakeAccessLapseTrigger,
  now: Date
): Promise<string[]> {
  const successorUserId = organization.userId;
  // The billing owner IS the departing member: `revokeAccess` drops them from `users[]` without
  // clearing `organization.userId`, so they remain the org's owner and succeeding to themselves
  // would be a no-op that merely logged. Their retained access is consistent with still owning the
  // org, not a hole. (`leave` cannot reach here at all - it refuses the org's owner outright.)
  if (!successorUserId || successorUserId === departedUserId) return [];

  const createdByDeparted = orgLakes.filter(lake => lake.createdByUserId === departedUserId);
  if (createdByDeparted.length === 0) return [];

  // Scoped to just these lakes rather than the whole org's grants: a member creates few lakes, and
  // this is only asked when they created any at all.
  const activeGrants = await db.dataLakeAccessGrants.listActiveByLakes(
    createdByDeparted.map(lake => lake.id),
    { activeAsOf: now }
  );

  const grantsByLake = new Map<string, LakeGrant[]>();
  for (const grant of activeGrants) {
    const list = grantsByLake.get(grant.dataLakeId) ?? [];
    list.push({ principalType: grant.principalType, principalId: grant.principalId, role: grant.role });
    grantsByLake.set(grant.dataLakeId, list);
  }

  const succeeded: string[] = [];
  for (const lake of createdByDeparted) {
    // Asked through `resolveEffectiveOwnerIds` rather than a local owner-grant predicate, so the
    // succession decision cannot drift from the rule the gates enforce: it is the same function
    // `isEffectiveOwner` reads, and therefore what `canManageLake`'s owner rung - and through it
    // `classifyLakeAccess`' `owner-admin` arm - resolves ownership with. For a lake the departing
    // member created it returns them when no owner grant supersedes the creator, so "somebody else
    // is already the owner" is exactly "an id other than the departing member". It also keeps phase
    // 1's write out of the decision: whether the row it just expired is visible here changes
    // nothing. Note what it deliberately does NOT count as an owner - an ORGANIZATION-principal
    // owner grant, and an owner row with no `principalId` - both of which would otherwise leave a
    // lake resolving to the departed creator.
    const owners = resolveEffectiveOwnerIds(lake, grantsByLake.get(lake.id));
    if (owners.some(ownerId => ownerId !== departedUserId)) continue;

    await db.dataLakeAccessGrants.upsertGrant({
      dataLakeId: lake.id,
      principalType: 'user',
      principalId: successorUserId,
      role: 'owner',
      grantedByUserId: triggeredBy.userId,
      expiresAt: null,
    });
    await audit(lake, 'membership-succession', [ownershipChange([departedUserId], successorUserId)]);
    succeeded.push(lake.id);
  }

  return succeeded;
}

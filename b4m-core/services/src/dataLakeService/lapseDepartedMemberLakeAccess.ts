import type { IDataLakeAccessGrantRepository, IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { grantChange, ownershipChange } from './diffLakeConfig';
import { lakeConfigWriteStamp } from './lakeConfigWriteStamp';
import { resolveEffectiveOwnerIds, type LakeGrant, type ManageActor } from './manageRule';
import { recordLakeConfigChange, type LakeConfigAuditAdapters } from './recordLakeConfigChange';

export interface LapseDepartedMemberLakeAccessAdapters extends LakeConfigAuditAdapters {
  // The event repo is REQUIRED here, matching `transferLakeOwnership`: the only callers are the two
  // org-departure routes, so nothing is spared by making it optional and a route that forgot to
  // wire it would go dark silently - the one failure mode an access-revocation audit must not have.
  db: LakeConfigAuditAdapters['db'] & {
    lakeConfigChangeEvents: NonNullable<LakeConfigAuditAdapters['db']['lakeConfigChangeEvents']>;
    // `update` carries phase 2's actor stamp. It is also what makes the lake DOCUMENT a write both
    // this path and `transferLakeOwnership` touch for the same lake, which is what a transaction
    // needs in order to detect the two colliding - see the serialization note on phase 2.
    dataLakes: Pick<IDataLakeRepository, 'findByOrganizationId' | 'update'>;
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
 * the person, so neither is touched. The first half of that holds at the CALLER too, not only here:
 * `revokeAccess` refuses a target who is not a current member (`isCurrentOrgMember`), so an org
 * admin cannot name an arbitrary user and have their grants lapsed as though they had departed.
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

  // Unfiltered and unbounded by design - every lake of the org, draft and archived included, since
  // a grant on any of them outlives the membership just the same. Both phases then write once per
  // affected grant, SEQUENTIALLY (see below) and inside the caller's transaction, so the work is
  // linear in lakes-per-org against the route's 60s Lambda timeout. Fine at current org sizes; if
  // an org's lake count ever approaches the hundreds this is the line that needs paging, and the
  // failure mode to watch for is a departure timing out half-applied rather than erroring cleanly.
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
        // no lake-side rung did, so `system` is stamped EXPLICITLY rather than resolved. That is
        // load-bearing, not redundant. `recordLakeConfigChange` is `manageRung ?? resolve... ??
        // 'system'`, and on the most ordinary case here - a member leaving a lake they created -
        // resolution would find the creator fallback and return `creator`, labelling a lifecycle
        // lapse as an owner-authorized write. Passing the rung short-circuits that. The zeroed
        // `isAdmin`/`administeredOrgIds` are belt-and-braces on an actor that is never consulted.
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
    now,
    logger
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
 * no meaningful order.
 *
 * THIS DOES CONFER ONE NEW CAPABILITY, and it is deliberate. For the manage rung and for read it
 * does not - `canManageLake`'s org rung already admitted the billing owner on every lake scoped to
 * that org. But `setLakeVisibility`'s expose gate is `isEffectiveOwner`, which deliberately excludes
 * that rung, and `transferLakeOwnership` refuses an org admin naming themselves - so before this,
 * the billing owner could not widen a member's lake to `public`. Now, for a lake whose creator left,
 * they can.
 *
 * That is accepted rather than guarded because the alternative is strictly worse. Withholding
 * succession does not leave the lake unowned; `resolveEffectiveOwnerIds` falls back to
 * `createdByUserId`, and `canManageLake` is consulted BEFORE the org prerequisite
 * (`classifyLakeAccess.ts:45` vs `:66`), so a FORMER member would keep full read, full manage and
 * that same expose gate on an org lake. The transfer guard's premise - an owner is present, and
 * their consent is being skipped - simply does not hold for a departure.
 *
 * The delta is also narrower than it first reads: an org admin can already share a lake org-wide
 * with an `organization`-principal reader grant (`lakeGrantWriteRule.ts:58-67`), so `public` is the
 * only genuinely new reach, and `setLakeVisibility` still hard-refuses publishing a lake carrying a
 * `requiredUserTag` or `requiredEntitlement`. `setLakeVisibility` and `transferLakeOwnership` both
 * carry the matching note, so the invariant is not documented in only one direction.
 *
 * SERIALIZATION against `transferLakeOwnership`, which is the other writer of an `owner` grant.
 * Both operations decide from a snapshot of a lake's grants and then write, so a transfer that
 * passed its gate before a departure committed would otherwise resume against stale grants,
 * re-mint the departed member (transfer DEMOTES prior owners to `curator` with `expiresAt: null`,
 * which overwrites the row phase 1 just expired) and leave the lake with two owners. Both paths now
 * run inside `withTransaction`, so Mongo aborts and retries whichever commits second and it re-reads
 * the grants - but only if the two actually touch a common document. That is why the stamp write
 * below matters beyond attribution: every lake this phase succeeds on gets a lake-DOCUMENT write,
 * and `transferLakeOwnership` writes the same document for its own stamp. So the two collide on the
 * grant row when the departing member held one, and on the lake document when they did not (the
 * creator-fallback case, which has no grant row to collide on until the transfer creates it).
 */
async function passOnCreatedLakes(
  departedUserId: string,
  organization: LapsingOrganization,
  orgLakes: IDataLakeDocument[],
  db: Db,
  audit: AuditFn,
  triggeredBy: LakeAccessLapseTrigger,
  now: Date,
  logger: LapseDepartedMemberLakeAccessAdapters['logger']
): Promise<string[]> {
  const successorUserId = organization.userId;
  // Succeeding to yourself is a no-op that would merely log. Neither departure path can actually
  // reach this with the billing owner as the departing member - `leave` refuses the org's owner
  // ("Cannot leave your own organization") and `revokeAccess` now refuses them too, because a
  // removal that leaves `organization.userId` pointing at the removed member ends nothing while
  // still expiring their grants. Kept as a guard rather than an assertion because this primitive
  // takes the successor from its caller: a third caller passing an org whose owner is the departing
  // member should get a no-op, not a self-grant.
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
    // Ownership lives in the grants, so without this the lake document itself would be untouched by
    // a change of owner and keep naming an older, smaller edit as its last editor - the same reason
    // `transferLakeOwnership` stamps, and the field's contract says every configuration write does.
    // Written AFTER the grant, matching transfer's ordering, so the stamp never claims a succession
    // that failed partway. Phase 1 deliberately does not stamp: an ordinary lapse changes who may
    // reach the lake, not the lake's configuration.
    //
    // NOT best-effort, which is where this diverges from transfer: that service is documented
    // non-atomic, so it swallows a stamp failure rather than reporting a transfer that in fact
    // succeeded. Both callers here run inside `withTransaction`, so a throw aborts and retries the
    // whole departure and there is no half-applied state to protect - swallowing would only hide a
    // real failure. A `null` result still warns rather than throws: `BaseModel.update` is a
    // `findOneAndUpdate` that resolves `null` when nothing matched, which inside the transaction's
    // snapshot means the lake went away between the org-wide read above and here.
    const stamp = lakeConfigWriteStamp(triggeredBy);
    if (stamp.lastUpdatedByUserId) {
      const stamped = await db.dataLakes.update({ id: lake.id, ...stamp });
      if (!stamped) {
        // Both members of `LakeConfigAuditLogger` are optional, and it falls back to console so the
        // stamp can never quietly name an older edit with nothing anywhere to say why. Called
        // through a closure rather than by reference so a logger whose method needs `this` works.
        const warn = (msg: string, meta: unknown) => (logger?.warn ? logger.warn(msg, meta) : console.warn(msg, meta));
        warn('[dataLakes] ownership passed on but the lake was not found for the actor stamp', {
          dataLakeId: lake.id,
        });
      }
    }

    await audit(lake, 'membership-succession', [ownershipChange([departedUserId], successorUserId)]);
    succeeded.push(lake.id);
  }

  return succeeded;
}

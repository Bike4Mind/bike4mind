import type {
  DataLakeOwnershipOfferRung,
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
  IDataLakeRepository,
  IOrganizationRepository,
  IUserRepository,
} from '@bike4mind/common';
import { BadRequestError, normalizeId } from '@bike4mind/utils';
import { resolveEffectiveOwnerIds, type LakeGrant, type ManageActor } from './manageRule';
import { assertLakeGrantable } from './assertLakeAccess';
import {
  isOrgOwnershipCandidate,
  resolveLakeTransferAuthority,
  type LakeTransferActor,
} from './lakeOwnershipCandidates';
import { lakeConfigWriteStamp } from './lakeConfigWriteStamp';
import { ownershipChange } from './diffLakeConfig';
import { recordLakeConfigChange, type LakeConfigAuditAdapters } from './recordLakeConfigChange';

/**
 * The adapters the AUTHORIZE half needs: only the two lookups the gate makes. Deliberately separate
 * from the write adapters so an offer (which authorizes but does not apply) can take exactly this.
 */
export interface AuthorizeLakeTransferAdapters {
  db: {
    users: Pick<IUserRepository, 'findById'>;
    organizations: Pick<IOrganizationRepository, 'findById'>;
  };
}

/** The authorization result: the recipient, cleared to receive, and the rung that cleared them. */
export interface LakeTransferAuthorization {
  newOwnerUserId: string;
  /**
   * The rung that authorized this transfer, for the config-change audit row. Resolved HERE rather
   * than left to `resolveLakeManageRung`, because this gate is deliberately narrower than
   * `canManageLake` (admin / effective owner / org-admin only - a curator manages but cannot hand
   * ownership away). The resolver mirrors canManageLake's wider ladder and checks the curator grant
   * BEFORE the org-admin rung, so it would label an org-admin succession `grant-curator` - naming an
   * authority this gate explicitly forbids from transferring. That is reachable: a prior transfer
   * DEMOTES each former owner to curator, so a creator who is also an org admin ends up holding
   * exactly that grant. `manageRung` is an authorization fact, so it must come from the branch that
   * actually authorized the call - which is `resolveLakeTransferAuthority`.
   */
  manageRung: DataLakeOwnershipOfferRung;
}

export interface ApplyLakeOwnershipTransferAdapters extends LakeConfigAuditAdapters {
  // The event repo is REQUIRED here, unlike the optional shape LakeConfigAuditAdapters carries
  // for recomputeLakeStats: every caller of this apply half comes from an API route (or an accept
  // driven by one), so nothing is spared by making it optional and a caller that forgot to wire it
  // would go dark silently - the one failure mode an audit must not have. Required here turns
  // that into a compile error.
  db: LakeConfigAuditAdapters['db'] & {
    lakeConfigChangeEvents: NonNullable<LakeConfigAuditAdapters['db']['lakeConfigChangeEvents']>;
    dataLakes: Pick<IDataLakeRepository, 'update'>;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'upsertGrant'>;
  };
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

export interface TransferLakeOwnershipAdapters extends ApplyLakeOwnershipTransferAdapters {
  db: ApplyLakeOwnershipTransferAdapters['db'] & AuthorizeLakeTransferAdapters['db'];
}

export interface TransferLakeOwnershipResult {
  newOwnerUserId: string;
  /** Prior effective owners demoted to curator by this transfer (empty when it was a no-op). */
  demotedUserIds: string[];
}

/**
 * The AUTHORIZE half of a lake ownership transfer: decide whether `actor` may hand `lake` to
 * `newOwnerUserId`, and name the rung that allowed it. Writes nothing.
 *
 * Authorization is deliberately NARROWER than `canManageLake`: only a platform admin, the current
 * effective owner, or an admin of the lake's org (the orphaned-creator succession path) may transfer
 * - a curator manages but does not own, so cannot hand ownership away.
 *
 * CONSENT GUARD (#1668 review B4): an actor authorized SOLELY by the org-admin rung - not the
 * effective owner, not a platform admin - may NOT name THEMSELVES as the new owner. Succession is a
 * reassignment to ANOTHER member, not a self-grab: without this an org admin could transfer a lake to
 * self and then use `setLakeVisibility`'s expose gate (which is `isEffectiveOwner`, precisely so an
 * admin cannot expose a lake without the owner consenting) to publish it - routing around the very
 * invariant that gate documents. Reassigning to another member is fine: the recipient is then a real
 * owner exposing their own lake. A platform admin is unconstrained (global superuser by definition).
 *
 * The guard's premise is that there IS an owner whose consent is being bypassed. It therefore does
 * not extend to `lapseDepartedMemberLakeAccess`, which mints an owner grant for the billing owner
 * when a lake's creator leaves the org: there, the owner is gone, and refusing succession would
 * leave ownership - and this door, and the expose gate - resolved to a former member. This service
 * path and that one are the only writers of an `owner` grant; the general door
 * (`lakeGrantWriteRule.ts:50`) still refuses the role outright.
 *
 * Refused for a fallback (hardcoded registry) lake, which has no backing document to hang a grant on
 * (`assertLakeGrantable`). For an org-scoped lake BOTH parties must belong to that org - the new
 * owner by the candidate predicate below, the actor by `resolveLakeTransferAuthority`'s membership
 * requirement (a grant outlives the membership that motivated it) - membership never crosses
 * organizations (epic decision 12).
 *
 * The lake's own content gate (`requiredUserTag` / `requiredEntitlement`) is deliberately NOT applied
 * to the recipient: ownership bypasses it (`classifyLakeAccess` returns on the owner arm), so a
 * transfer can hand gated content to a member who does not satisfy the gate. That is allowed because
 * refusing it would leave a gated lake with no succession path at all, but it is disclosed rather
 * than silent - the candidate list carries the gate and the confirmation names it, so the owner makes
 * the call knowingly. Contrast `setLakeVisibility`, which hard-refuses publishing a gated lake:
 * exposing it app-wide has no named recipient to hold accountable, a handover does.
 *
 * Both the offer door and the direct transfer call this, so the option set the picker offers and
 * every write that follows from it can never drift apart.
 */
export async function authorizeLakeTransfer(
  actor: LakeTransferActor,
  lake: IDataLakeDocument,
  grants: LakeGrant[],
  newOwnerUserId: string,
  { db }: AuthorizeLakeTransferAdapters
): Promise<LakeTransferAuthorization> {
  // Fallback lakes have no document and no createdByUserId to seed from - grants are refused.
  assertLakeGrantable(lake);

  const lakeOrg = normalizeId(lake.organizationId);
  // Shared with the candidate listing behind the transfer picker, so the option set a manager is
  // offered and the gate this write applies can never drift apart.
  const authority = resolveLakeTransferAuthority(lake, actor, grants);
  if (!authority.allowed) {
    // A personal lake is refused for everyone but a platform admin (see resolveLakeTransferAuthority),
    // which is not a permission the actor could acquire - so say what would actually unblock them
    // rather than implying they need a role.
    throw new BadRequestError(
      !lakeOrg && !actor.isAdmin
        ? 'A personal data lake cannot be transferred. Move it into an organization first, then transfer it to a member.'
        : 'You do not have permission to transfer ownership of this data lake'
    );
  }
  // Consent guard (see doc above): an org admin acting purely by the org-admin rung may reassign the
  // lake to another member, but may not grab ownership for themselves and then expose it around the
  // owner-only expose gate. A platform admin or the current owner is exempt.
  if (authority.viaOrgAdminOnly && newOwnerUserId === actor.userId) {
    throw new BadRequestError('An organization admin cannot transfer a data lake to themselves; name another member.');
  }

  const newOwner = await db.users.findById(newOwnerUserId);
  if (!newOwner) {
    throw new BadRequestError('The chosen new owner could not be found');
  }

  // Org-scoped lake: the new owner must be a member of the owning org (billing owner, appointed
  // admin, or on the users[] ACL). Membership never crosses organizations, so an out-of-org target
  // is refused rather than silently granted.
  if (lakeOrg) {
    const org = await db.organizations.findById(lakeOrg);
    // Same predicate the picker enumerates from (`listOrgOwnershipCandidateIds`), so this can never
    // reject a teammate the UI offered.
    if (!org || !isOrgOwnershipCandidate(org, newOwnerUserId)) {
      throw new BadRequestError('The new owner must belong to the organization that owns this data lake');
    }
  }

  // Ownership is checked BEFORE the admin bypass, matching `resolveLakeManageRung`: an owner who
  // also happens to be a platform admin transferred their OWN lake, and naming the admin rung there
  // reads as an outside intervention on the history surface.
  const manageRung: DataLakeOwnershipOfferRung = authority.isOwner
    ? grants.some(g => g.principalType === 'user' && g.principalId === actor.userId && g.role === 'owner')
      ? 'grant-owner'
      : 'creator'
    : actor.isAdmin
      ? 'platform-admin'
      : 'org-admin';

  return { newOwnerUserId, manageRung };
}

/**
 * The APPLY half: move a lake's ownership to another user WITHOUT mutating `createdByUserId` (which
 * stays the immutable creator/provenance identity and the membership prefix-arm anchor). Ownership is
 * carried by an `owner`-role access grant: this upserts one for the new owner, so
 * `resolveEffectiveOwnerIds` now returns them, and demotes each prior effective owner to `curator` -
 * they keep management access (reversible), just not ownership. When the lake had no owner grant yet
 * (ownership was the `createdByUserId` fallback), the creator is the demoted party, so they retain
 * access as a curator.
 *
 * Assumes the caller already ran `authorizeLakeTransfer` and passes its `manageRung` through, so the
 * audit row names the authority that actually decided the transfer.
 *
 * TAKES NO SESSION ITSELF, but its callers supply one. The recipient's grant, each demotion, the actor
 * stamp and the audit row are separate writes; this service stays adapter-injected and connection-free
 * by design, so the wrapping belongs at the route seam - and both
 * `pages/api/data-lakes/[id]/transfer-ownership.ts` and the offer accept do it, with the access gate
 * INSIDE the callback so a retry re-reads the grants rather than reusing a stale snapshot. Two
 * failures that buys: a failure mid-loop no longer leaves the lake with two effective owners and no
 * transfer row to explain it, and a concurrent DEPARTURE can no longer interleave.
 *
 * That second one is worth spelling out, because it is the only cross-operation race on ownership.
 * `lapseDepartedMemberLakeAccess` expires a departing member's grants and may mint an owner grant
 * for the billing owner. Between this function's caller's gate and these writes, that can commit -
 * and the demotion loop below would then upsert the departed member back to `curator` with
 * `expiresAt: null`, over the very row the departure expired, leaving the lake with two owners and
 * the departed member holding live access. Both paths inside a transaction turns that interleaving
 * into a write conflict on a shared document, which Mongo aborts and retries. The shared document is
 * the demoted grant row when the departing member held one, and the LAKE document otherwise - both
 * paths write it for their actor stamp, which is why that stamp is load-bearing beyond attribution.
 * The LAKE arm needs the departure's own trigger to be attributable, which both of its callers are;
 * see the serialization note on `lapseDepartedMemberLakeAccess`'s phase 2.
 *
 * Every write is still idempotent (retrying the same transfer converges) and the ordering still
 * holds - the audit is written LAST so it can never claim a transfer that failed partway.
 */
export async function applyLakeOwnershipTransfer(
  actor: ManageActor,
  lake: IDataLakeDocument,
  grants: LakeGrant[],
  newOwnerUserId: string,
  manageRung: DataLakeOwnershipOfferRung,
  { db, logger }: ApplyLakeOwnershipTransferAdapters
): Promise<TransferLakeOwnershipResult> {
  const priorOwners = resolveEffectiveOwnerIds(lake, grants);

  await db.dataLakeAccessGrants.upsertGrant({
    dataLakeId: lake.id,
    principalType: 'user',
    principalId: newOwnerUserId,
    role: 'owner',
    grantedByUserId: actor.userId,
    // Ownership never expires; clear any prior expiry a lapsed grant on this principal carried.
    expiresAt: null,
  });

  const demotedUserIds: string[] = [];
  for (const priorOwnerUserId of priorOwners) {
    if (priorOwnerUserId === newOwnerUserId) continue;
    await db.dataLakeAccessGrants.upsertGrant({
      dataLakeId: lake.id,
      principalType: 'user',
      principalId: priorOwnerUserId,
      role: 'curator',
      grantedByUserId: actor.userId,
      expiresAt: null,
    });
    demotedUserIds.push(priorOwnerUserId);
  }

  // Ownership lives in the grants, not on the document, so this is the one config write that would
  // otherwise leave the lake itself untouched - and a transfer is the change most worth attributing.
  // Written AFTER the grants so the stamp never claims a transfer that failed partway. The grant
  // rows carry `grantedByUserId` independently; this keeps the lake's own "who last changed me"
  // answer true rather than pointing at an older, smaller edit.
  // Guarded, unlike the other call sites: this write exists ONLY to carry the stamp, so an
  // unattributable actor would otherwise cost a round trip that sets nothing.
  //
  // Best-effort for the same reason it is ordered last: the grants above have already moved
  // ownership, so throwing here would report a failed transfer that in fact succeeded and invite a
  // retry of an operation that is done. An audit write must never fail the operation it audits -
  // but it must not fail SILENTLY either, since the only other symptom is a stamp that quietly
  // names an older, smaller edit.
  const stamp = lakeConfigWriteStamp(actor);
  if (stamp.lastUpdatedByUserId) {
    // Falls back to console when no logger is wired, so neither failure shape below can go silent:
    // `logger` is optional on the adapters, and a swallowed failure with no output would leave the
    // stamp quietly naming an older, smaller edit with nothing anywhere to say why. Called through a
    // closure rather than passing `logger.warn` by reference, so a logger whose method needs `this`
    // still works.
    const warn = (msg: string, meta: unknown) => (logger ? logger.warn(msg, meta) : console.warn(msg, meta));
    try {
      // The return value matters as much as the throw: `BaseModel.update` is a `findOneAndUpdate`
      // that RESOLVES `null` when no document matches, so a lake deleted between the caller's access
      // gate (where this lake was resolved) and this final write - several awaits apart: grant
      // upserts - would no-op with no exception for the catch to see. The window is one round-trip
      // wider than when this function resolved the lake itself. Checking the result is what makes
      // "never fails silently" true for BOTH shapes, not just the throwing one.
      const stamped = await db.dataLakes.update({ id: lake.id, ...stamp });
      if (!stamped) {
        warn('[dataLakes] ownership transferred but the lake was not found for the actor stamp', {
          dataLakeId: lake.id,
        });
      }
    } catch (err) {
      warn('[dataLakes] ownership transferred but the actor stamp did not persist', {
        dataLakeId: lake.id,
        err,
      });
    }
  }

  // Ownership moves through grant rows, so `diffLakeConfig` can never see this change - the lake
  // document is byte-identical apart from the stamp above. `ownershipChange` synthesizes the entry
  // on the derived `effectiveOwnerUserId` field so a transfer reads as an ordinary before -> after
  // row in the history rather than an action with nothing to show.
  //
  // Recorded from the grants the GATE used, not a re-read, and only after they have landed - the
  // same ordering the stamp uses, and for the same reason: never claim a transfer that failed
  // partway. The rung is passed EXPLICITLY from the authorize half that produced it.
  await recordLakeConfigChange(
    {
      actor,
      lake,
      grants,
      action: 'transfer-ownership',
      manageRung,
      changes: [ownershipChange(priorOwners, newOwnerUserId)].filter(c => c !== null),
    },
    { db, logger }
  );

  return { newOwnerUserId, demotedUserIds };
}

/**
 * Transfer a lake's ownership directly: authorize, then apply, in one call.
 *
 * Kept as the seam that short-circuits for callers that genuinely must move ownership without the
 * recipient's consent - today none, since the route now offers and the recipient accepts. Prefer
 * `offerLakeOwnership` + `acceptLakeOwnershipOffer`; this remains the composed primitive the offer
 * path's apply half came from, and the shape the direct-transfer tests pin.
 */
export const transferLakeOwnership = async (
  actor: LakeTransferActor,
  lake: IDataLakeDocument,
  grants: LakeGrant[],
  newOwnerUserId: string,
  { db, logger }: TransferLakeOwnershipAdapters
): Promise<TransferLakeOwnershipResult> => {
  const { manageRung } = await authorizeLakeTransfer(actor, lake, grants, newOwnerUserId, { db });
  return applyLakeOwnershipTransfer(actor, lake, grants, newOwnerUserId, manageRung, { db, logger });
};

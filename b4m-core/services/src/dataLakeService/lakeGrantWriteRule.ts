import type { DataLakeAccessRole, DataLakePrincipalType, IDataLakeDocument } from '@bike4mind/common';
import { normalizeId } from '@bike4mind/utils';

/** What a caller asks this door to grant: one principal, one role on one lake. */
export interface LakeGrantWriteInput {
  principalType: DataLakePrincipalType;
  principalId: string;
  role: DataLakeAccessRole;
  /** Absent leaves any existing expiry alone; `null` clears it. See `upsertGrant`. */
  expiresAt?: Date | null;
}

/**
 * The refusal rules for the routine grant door, as a pure sync function: the denial message, or
 * `null` to allow. Kept out of the service so cross-org containment is pinned by a unit test rather
 * than by review - `resolveReadGrant` honors an org-principal grant with NO same-org check of its
 * own (see the "MUST STAY IN SYNC WITH THE WRITE PATH" note on `resolveLakeReadAccess`), so this
 * function is the primary enforcement of that containment. Not the only one: the other producers of
 * grant rows carry their own (`createDataLake`'s self-grant names the creator, and
 * `transferLakeOwnership` refuses an out-of-org new owner for an org-scoped lake).
 *
 * Two refusals, for two different reasons:
 *
 *  1. `owner` is not writable here. Ownership moves ONLY through `transferLakeOwnership`, which
 *     carries a narrower authority ladder (`resolveLakeTransferAuthority` - a curator manages but
 *     cannot hand ownership away), the org-admin self-grab consent guard, and the demote-priors
 *     loop. This door gates on `canManageLake`, whose curator rung would otherwise let a curator
 *     grant themselves `owner` and route around all three.
 *  2. An `organization` principal must be the lake's OWN org. Membership never crosses organizations
 *     (epic decision 12), and a personal lake has no org, so it can hold no org grant at all.
 *  3. An `organization` principal can only be a READER. There is no principal such a grant could
 *     confer management on: `canManageLake`'s org-grant rung fires only for an org the actor
 *     ADMINISTERS, and by rule 2 that org is the lake's own - whose admins already passed the
 *     rung above it. So an org curator grant changes nobody's capability at any enforcement
 *     setting, while reading in the audit trail as though org-wide management had been handed out.
 *
 * USER principals are deliberately NOT org-checked: a cross-tenant user grant is the headline case
 * this relation exists for ("someone who is neither the creator nor a member of its organization"),
 * and `LakeAccessGrantView` already withholds email because a grant holder may be an arbitrary
 * cross-tenant principal. Only the ORG arm is contained.
 */
export function refuseGrantWrite(
  lake: Pick<IDataLakeDocument, 'organizationId'>,
  input: LakeGrantWriteInput,
  now: Date = new Date()
): string | null {
  if (!input.principalId) {
    return 'A grant must name a principal';
  }
  if (input.role === 'owner') {
    return 'Ownership cannot be granted here; use transfer ownership instead';
  }
  // A grant that has already lapsed is filtered out of every active read the moment it lands, so
  // writing one would look to the manager like a silent no-op rather than a mistake.
  if (input.expiresAt && input.expiresAt.getTime() <= now.getTime()) {
    return 'A grant cannot expire in the past';
  }
  if (input.principalType === 'organization') {
    const lakeOrg = normalizeId(lake.organizationId);
    if (!lakeOrg) {
      return 'This data lake belongs to no organization, so it cannot be shared with one';
    }
    if (lakeOrg !== input.principalId) {
      return 'A data lake can only be shared with the organization that owns it';
    }
    if (input.role === 'curator') {
      return 'An organization can only be granted reader access; its admins already manage this data lake';
    }
  }
  return null;
}

/**
 * The refusal rule for touching a grant that ALREADY EXISTS, applied by both doors.
 *
 * An `owner`-role row is the lake's ownership. Revoking it, or re-roling it down to curator/reader,
 * both un-transfer the lake - `resolveEffectiveOwnerIds` falls back to `createdByUserId` or to
 * whatever other owner grant remains - through a door that never named a successor. `refuseGrantWrite`
 * cannot catch the re-role case: it sees only the REQUESTED role, which is a perfectly legal
 * `curator`. So the check has to be made against the row being overwritten, which the caller can only
 * know after loading it.
 *
 * A principal with no existing grant is not a refusal - there is nothing to protect.
 */
export function refuseOwnerGrantChange(existing: Pick<LakeGrantWriteInput, 'role'> | null): string | null {
  if (existing?.role === 'owner') {
    return 'This is an ownership grant; use transfer ownership to change it';
  }
  return null;
}

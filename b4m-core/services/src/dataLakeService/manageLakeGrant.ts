import type {
  DataLakeAccessRole,
  DataLakePrincipalType,
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
  IDataLakeRepository,
  IUserRepository,
} from '@bike4mind/common';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/utils';
import { canManageLake, type ManageActor } from './manageRule';
import { assertLakeGrantable } from './assertLakeAccess';
import { loadActiveLakeGrants } from './authorizeLakeManage';
import { grantChange } from './diffLakeConfig';
import { refuseGrantRevoke, refuseGrantWrite } from './lakeGrantWriteRule';
import { recordLakeConfigChange, type LakeConfigAuditAdapters } from './recordLakeConfigChange';

/**
 * REQUIRED audit repo, unlike the optional shape `LakeConfigAuditAdapters` carries: this door has
 * exactly one caller (its API route), and an access change is the most audit-relevant write on a
 * lake, so a route that forgot to wire the trail would go dark silently. Required makes it a
 * compile error - same reasoning as `TransferLakeOwnershipAdapters`.
 */
interface ManageLakeGrantAdapters extends LakeConfigAuditAdapters {
  db: LakeConfigAuditAdapters['db'] & {
    lakeConfigChangeEvents: NonNullable<LakeConfigAuditAdapters['db']['lakeConfigChangeEvents']>;
    dataLakes: Pick<IDataLakeRepository, 'findById'>;
    dataLakeAccessGrants: Pick<
      IDataLakeAccessGrantRepository,
      'listByLake' | 'findGrant' | 'upsertGrant' | 'removeGrant'
    >;
    users: Pick<IUserRepository, 'findByEmail'>;
  };
}

export interface GrantLakeAccessInput {
  principalType: DataLakePrincipalType;
  /** The principal's id. Optional only when `principalEmail` identifies a `user` principal. */
  principalId?: string;
  /**
   * A `user` principal named by email instead of id - the only workable input for the cross-tenant
   * sharing case this relation exists for, since a manager granting access outside their own org
   * has no way to learn a userId. Resolved by EXACT lookup (`findByEmail`), never a search, so this
   * adds no user-enumeration surface beyond the yes/no an exact address already answers; the door
   * is manage-gated, so that oracle is never anonymous.
   */
  principalEmail?: string;
  role: DataLakeAccessRole;
  expiresAt?: Date | null;
}

export interface RevokeLakeAccessInput {
  principalType: DataLakePrincipalType;
  principalId: string;
}

export interface GrantLakeAccessResult {
  principalType: DataLakePrincipalType;
  principalId: string;
  role: DataLakeAccessRole;
  /** The role the principal held before, absent if this created the grant. */
  previousRole?: DataLakeAccessRole;
}

export interface RevokeLakeAccessResult {
  /** False when the principal held no grant - an accepted no-op, not a failure. */
  revoked: boolean;
}

/** The shared prologue: load, refuse a fallback lake, and apply the manage gate once. */
async function loadManageableLake(
  actor: ManageActor,
  dataLakeId: string,
  { db }: ManageLakeGrantAdapters
): Promise<{ lake: IDataLakeDocument; grants: Awaited<ReturnType<typeof loadActiveLakeGrants>> }> {
  const lake = await db.dataLakes.findById(dataLakeId);
  if (!lake) {
    throw new NotFoundError('Data lake not found');
  }
  // A hardcoded registry lake has no document to hang a grant row on.
  assertLakeGrantable(lake);

  const grants = await loadActiveLakeGrants(lake, { db });
  if (!canManageLake(lake, actor, grants)) {
    // Forbidden, not BadRequest: the route access-gates first, so a caller reaching here can already
    // see the lake and nothing is disclosed by saying they may not manage it. Same call the access
    // view's own manage gate makes.
    throw new ForbiddenError('You do not have permission to manage access to this data lake');
  }
  return { lake, grants };
}

/**
 * Grant a principal access to a lake, or re-role the grant they already hold. The routine sharing
 * door: the sole producer of `reader` and organization grants, which the relation has had none of.
 *
 * Gated on `canManageLake` (admin / effective owner / curator / org admin / org grant), then on the
 * pure `refuseGrantWrite` rules - notably that `owner` is not writable here (ownership moves only
 * through `transferLakeOwnership`) and that an organization principal must be the lake's own org
 * (the cross-org containment `resolveReadGrant` delegates to this path).
 *
 * Idempotent: `upsertGrant` is keyed on (lake, principalType, principalId), so re-granting the same
 * role converges and records NO audit event (`grantChange` returns null) - a request that changed
 * nothing is not a change.
 *
 * ONE write, so no transaction is needed - contrast `transferLakeOwnership`'s explicit NOT ATOMIC
 * note, which covers a multi-write loop. The audit is still recorded LAST, so it can never claim a
 * grant that failed.
 *
 * Reader grants are RECORDED but not yet ENFORCED: `READ_GRANT_ENFORCEMENT_READY` gates the read
 * arm, so until it flips a reader grant lists nothing. The access route reports that state to the
 * UI (`meta.readerGrantsEnforced`) rather than letting the row look live.
 */
export async function grantLakeAccess(
  actor: ManageActor,
  dataLakeId: string,
  input: GrantLakeAccessInput,
  adapters: ManageLakeGrantAdapters
): Promise<GrantLakeAccessResult> {
  const { db, logger } = adapters;
  const { lake, grants } = await loadManageableLake(actor, dataLakeId, adapters);

  const principalId = await resolvePrincipalId(input, db);
  const refusal = refuseGrantWrite(lake, { ...input, principalId });
  if (refusal) {
    throw new BadRequestError(refusal);
  }

  // The persisted row, not the ACTIVE grant set: a lapsed grant is still the row being overwritten,
  // so it is the honest `before` for the audit and for the caller's result.
  const existing = await db.dataLakeAccessGrants.findGrant(lake.id, input.principalType, principalId);

  await db.dataLakeAccessGrants.upsertGrant({
    dataLakeId: lake.id,
    principalType: input.principalType,
    principalId,
    role: input.role,
    grantedByUserId: actor.userId,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  });

  await recordLakeConfigChange(
    {
      actor,
      lake,
      // The grants the GATE used, so the rung resolves to grant-owner/grant-curator/org-grant rather
      // than collapsing to the creator arm.
      grants,
      action: 'grant-access',
      changes: [grantChange(input.principalType, principalId, existing?.role, input.role)].filter(c => c !== null),
    },
    { db, logger }
  );

  return { principalType: input.principalType, principalId, role: input.role, previousRole: existing?.role };
}

/**
 * Revoke a principal's grant on a lake. Refuses an `owner`-role row, which is the lake's ownership:
 * dropping it here would silently un-transfer the lake through a door that never named a new owner.
 *
 * A principal with no grant is an accepted no-op (`revoked: false`) rather than a 404 - the caller
 * asked for a state that already holds, and a manager racing a peer's revoke should not see an error
 * for the outcome they wanted.
 */
export async function revokeLakeAccess(
  actor: ManageActor,
  dataLakeId: string,
  input: RevokeLakeAccessInput,
  adapters: ManageLakeGrantAdapters
): Promise<RevokeLakeAccessResult> {
  const { db, logger } = adapters;
  const { lake, grants } = await loadManageableLake(actor, dataLakeId, adapters);

  const existing = await db.dataLakeAccessGrants.findGrant(lake.id, input.principalType, input.principalId);
  if (!existing) return { revoked: false };

  const refusal = refuseGrantRevoke(existing);
  if (refusal) {
    throw new BadRequestError(refusal);
  }

  const revoked = await db.dataLakeAccessGrants.removeGrant(lake.id, input.principalType, input.principalId);
  if (!revoked) return { revoked: false };

  await recordLakeConfigChange(
    {
      actor,
      lake,
      grants,
      action: 'revoke-access',
      changes: [grantChange(input.principalType, input.principalId, existing.role, undefined)].filter(c => c !== null),
    },
    { db, logger }
  );

  return { revoked: true };
}

/**
 * The granted principal's id, from `principalId` or - for a `user` principal - an exact email
 * lookup. Refused rather than defaulted when neither resolves: inventing a principal is the one
 * mistake an access write must not make.
 */
async function resolvePrincipalId(input: GrantLakeAccessInput, db: ManageLakeGrantAdapters['db']): Promise<string> {
  if (input.principalId) return input.principalId;
  if (input.principalType !== 'user' || !input.principalEmail) {
    throw new BadRequestError('A grant must name a principal');
  }
  const user = await db.users.findByEmail(input.principalEmail);
  if (!user) {
    throw new BadRequestError('No account was found for that email address');
  }
  return user.id;
}

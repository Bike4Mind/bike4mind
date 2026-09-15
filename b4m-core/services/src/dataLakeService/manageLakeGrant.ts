import type {
  DataLakeAccessRole,
  DataLakePrincipalType,
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
  IUserRepository,
} from '@bike4mind/common';
import { BadRequestError, ForbiddenError } from '@bike4mind/utils';
import { canManageLake, type LakeGrant, type ManageActor } from './manageRule';
import { assertLakeGrantable } from './assertLakeAccess';
import { grantChange } from './diffLakeConfig';
import { refuseGrantWrite, refuseOwnerGrantChange } from './lakeGrantWriteRule';
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
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'findGrant' | 'upsertGrant' | 'removeGrant'>;
    users: Pick<IUserRepository, 'findAllByEmailsOrUsernames'>;
  };
}

export interface GrantLakeAccessInput {
  principalType: DataLakePrincipalType;
  /** The principal's id. An `organization` principal only - see `principalEmail`. */
  principalId?: string;
  /**
   * A `user` principal, named by email. The ONLY way to name one, deliberately: it is the only
   * workable input for the cross-tenant sharing case this relation exists for (a manager granting
   * access outside their own org has no way to learn a userId), and it is the only one that cannot
   * invent a principal. Resolved by WHOLE-ADDRESS lookup, never a prefix or substring search, so
   * this adds no user-enumeration surface beyond the yes/no an exact address already answers; the
   * door is manage-gated, so that oracle is never anonymous. The lookup is case-INSENSITIVE while
   * the uniqueness index is not, so it can match more than one account - see `resolvePrincipalId`.
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

/**
 * The shared prologue: refuse a fallback lake, then apply the manage gate once. Pure over an
 * already-resolved lake and its ACTIVE grants - both doors below are reached through the route's
 * `assertLakeAccessWithGrants`, which read exactly this pair, so neither is re-fetched here. The
 * missing-lake refusal lives in that gate too, as a not-found-style denial.
 */
function assertManageableLake(lake: IDataLakeDocument, actor: ManageActor, grants: LakeGrant[]): void {
  // A hardcoded registry lake has no document to hang a grant row on.
  assertLakeGrantable(lake);

  if (!canManageLake(lake, actor, grants)) {
    // Forbidden, not BadRequest: the route access-gates first, so a caller reaching here can already
    // see the lake and nothing is disclosed by saying they may not manage it. Same call the access
    // view's own manage gate makes.
    throw new ForbiddenError('You do not have permission to manage access to this data lake');
  }
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
 * A CURATOR CANNOT MINT ANOTHER CURATOR. `canManageLake`'s curator rung is deliberately transitive
 * for routine sharing (a curator is there to hand out reader access), but letting it hand out its
 * OWN rung makes curatorship self-propagating: an owner who appoints one curator has, from that
 * moment, no way to bound the set of people who manage the lake, and no rung above reader is ever
 * required again. Refused only when a curator grant is the actor's ONLY authority here, so a
 * principal who manages this lake by some other rung and happens to hold one too is unaffected.
 *
 * Idempotent: `upsertGrant` is keyed on (lake, principalType, principalId), so re-granting the same
 * role on the same terms converges and records NO audit event (`grantChange` returns null) - a
 * request that changed nothing is not a change. A re-grant over a LAPSED row is not that case: it
 * clears the dead expiry and so restores access, which is audited even when the role is unchanged.
 * Neither is a re-grant that only moves the EXPIRY: the expiry is part of what the grant confers, so
 * it rides in the audited value (see `grantChange`) instead of landing as a silent write.
 *
 * ONE write, so no transaction is needed - contrast `transferLakeOwnership`'s explicit NOT ATOMIC
 * note, which covers a multi-write loop. The audit is still recorded LAST, so it can never claim a
 * grant that failed.
 *
 * Reader grants are RECORDED here and RESOLVED at read time only while the `EnforceLakeReadGrants`
 * platform setting is on - the source interlock has flipped, so that setting is the whole
 * OPERATOR-facing gate, and it defaults to ON. One path still forces readers off independently of
 * it: a caller that wired no settings adapter cannot resolve the setting and degrades to `false`
 * rather than guess (`listDataLakes.ts`, `resolveLakeReadAccess.ts`).
 * The access route reports the resolved state to the UI (`meta.readerGrantsEnforced`) rather than
 * letting a row look live when it admits nobody.
 */
export async function grantLakeAccess(
  actor: ManageActor,
  lake: IDataLakeDocument,
  grants: LakeGrant[],
  input: GrantLakeAccessInput,
  adapters: ManageLakeGrantAdapters
): Promise<GrantLakeAccessResult> {
  const { db, logger } = adapters;
  assertManageableLake(lake, actor, grants);

  const principalId = await resolvePrincipalId(input, db);
  const refusal = refuseGrantWrite(lake, { ...input, principalId });
  if (refusal) {
    throw new BadRequestError(refusal);
  }
  // The persisted row, not the ACTIVE grant set: a lapsed grant is still the row being overwritten,
  // so it is what the owner refusal and the expiry resolution below both have to be judged against.
  const existing = await db.dataLakeAccessGrants.findGrant(lake.id, input.principalType, principalId);
  // Checked against the ROW, not the request: refuseGrantWrite sees only the requested role, so a
  // re-role of the owner down to curator would sail past it and quietly un-transfer the lake. A
  // LAPSED owner row still counts - the expiry says nothing about who owns the lake.
  const ownerRefusal = refuseOwnerGrantChange(existing);
  if (ownerRefusal) {
    throw new BadRequestError(ownerRefusal);
  }

  // Non-transitive curatorship - see the note above. Asked by re-running the GATE without the
  // actor's own curator grant, so it refuses exactly the actor whose sole authority is that grant.
  // Deliberately NOT an equality test against `resolveLakeManageRung`: that function's order is
  // tuned for audit display (`platform-admin` is reported last on purpose), so `grant-curator`
  // outranks both admin rungs there and an equality form refused an org admin and a platform admin
  // who also held a curator grant - the two principals this exemption exists for. Ordered AFTER the
  // owner-row refusal: a curator aiming at an ownership row is told the wrong thing if the reply is
  // about their own rung - the row is the reason.
  if (input.role === 'curator') {
    const withoutOwnCuratorGrant = grants.filter(
      g => !(g.principalType === 'user' && g.principalId === actor.userId && g.role === 'curator')
    );
    if (!canManageLake(lake, actor, withoutOwnCuratorGrant)) {
      throw new BadRequestError('Curators cannot grant curator access; ask an owner or an organization admin');
    }
  }

  // A lapsed row conferred nothing, so it is neither an expiry worth keeping nor an honest `before`.
  // Keeping it would write the new role onto a past date, which `loadActiveLakeGrants` still filters
  // out - the silent no-op `refuseGrantWrite` refuses to create outright. Reporting the lapsed role
  // as the `before` would claim access was downgraded when in fact it was restored, and would make a
  // same-role reactivation record nothing at all (`grantChange` returns null on before === after).
  const lapsed = !!existing?.expiresAt && existing.expiresAt.getTime() <= Date.now();
  const previousRole = lapsed ? undefined : existing?.role;
  const expiresAt = input.expiresAt !== undefined ? input.expiresAt : lapsed ? null : undefined;

  // The audited before/after terms. `expiresAt` above is the WRITE's intent, where `undefined` means
  // "leave whatever is there alone" - which is not the resulting state, so the audit resolves it
  // against the row rather than recording an omission as a clear.
  const previousExpiresAt = lapsed ? null : (existing?.expiresAt ?? null);
  const nextExpiresAt = expiresAt !== undefined ? expiresAt : (existing?.expiresAt ?? null);

  await db.dataLakeAccessGrants.upsertGrant({
    dataLakeId: lake.id,
    principalType: input.principalType,
    principalId,
    role: input.role,
    grantedByUserId: actor.userId,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });

  await recordLakeConfigChange(
    {
      actor,
      lake,
      // The grants the GATE used, so the rung resolves to grant-owner/grant-curator/org-grant rather
      // than collapsing to the creator arm.
      grants,
      action: 'grant-access',
      changes: [
        grantChange(input.principalType, principalId, previousRole, input.role, previousExpiresAt, nextExpiresAt),
      ].filter(c => c !== null),
    },
    { db, logger }
  );

  return { principalType: input.principalType, principalId, role: input.role, previousRole };
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
  lake: IDataLakeDocument,
  grants: LakeGrant[],
  input: RevokeLakeAccessInput,
  adapters: ManageLakeGrantAdapters
): Promise<RevokeLakeAccessResult> {
  const { db, logger } = adapters;
  assertManageableLake(lake, actor, grants);

  const existing = await db.dataLakeAccessGrants.findGrant(lake.id, input.principalType, input.principalId);
  if (!existing) return { revoked: false };

  const refusal = refuseOwnerGrantChange(existing);
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
      // The removed row's own expiry rides in the `before`, so revoking a LAPSED grant does not read
      // as though live access was taken away. It cannot be dropped to `undefined` the way the grant
      // door drops a lapsed `previousRole`: with no `after` side, that would make `grantChange`
      // return null and lose the event for a write that did happen.
      changes: [
        grantChange(input.principalType, input.principalId, existing.role, undefined, existing.expiresAt ?? null),
      ].filter(c => c !== null),
    },
    { db, logger }
  );

  return { revoked: true };
}

/**
 * The granted principal's id: an exact email lookup for a `user`, the given id for an
 * `organization`. Refused rather than defaulted when neither resolves: inventing a principal is the
 * one mistake an access write must not make.
 *
 * A USER IS NOT NAMEABLE BY ID here, deliberately, and the reason is that this door has no way to
 * check one. The grant's natural key is (lake, principalType, principalId) against a `type: String`
 * field, so a mistyped id becomes a permanent row that `UserModel.findByIds` silently drops - an
 * unresolvable opaque principal in the compliance export - and a whitespace or case variant of a
 * real id becomes a SECOND row for the same person that no read can ever match. An email is the only
 * input that resolves to a real account before anything is written. An `organization` id needs no
 * such check: `refuseGrantWrite` pins it to the lake's own org, so there is nothing to invent.
 *
 * AMBIGUITY IS REFUSED, NOT RESOLVED, and this is why the plural lookup is used for a single
 * address. Email uniqueness on the users collection is case-SENSITIVE (`email_1`) while every
 * caller-facing lookup collates case-INSENSITIVELY, so `a@b.co` and `A@b.co` can be two distinct
 * real accounts that one typed address matches. `findByEmail` is a `findOne` over exactly that
 * match set: it returns an arbitrary one of them, which on this door means the grant silently lands
 * on the wrong person's account. `UserModel.findAllByEmailsOrUsernames` carries the same obligation
 * in its own docblock, and `sharingService/create.ts` is the other caller that honors it.
 */
async function resolvePrincipalId(input: GrantLakeAccessInput, db: ManageLakeGrantAdapters['db']): Promise<string> {
  if (input.principalType !== 'user') {
    if (!input.principalId) {
      throw new BadRequestError('A grant must name a principal');
    }
    return input.principalId;
  }
  if (!input.principalEmail) {
    throw new BadRequestError('A grant must name the person to share with by email address');
  }
  const matches = await db.users.findAllByEmailsOrUsernames([input.principalEmail], []);
  if (matches.length === 0) {
    throw new BadRequestError('No account was found for that email address');
  }
  if (matches.length > 1) {
    throw new BadRequestError(
      'More than one account uses that email address, so it does not identify who to share with; ask an administrator to resolve the duplicate'
    );
  }
  return matches[0].id;
}

import type { IDataLakeAccessGrantRepository, IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { UpdateDataLakeRequestInput, normalizeEntitlementKey } from '@bike4mind/common';
import { secureParameters, BadRequestError, NotFoundError } from '@bike4mind/utils';
import { canManageLake, type ManageActor } from './manageRule';
import { loadActiveLakeGrants } from './authorizeLakeManage';
import { lakeConfigWriteStamp } from './lakeConfigWriteStamp';
import { diffLakeConfig } from './diffLakeConfig';
import { recordLakeConfigChange, type LakeConfigAuditAdapters } from './recordLakeConfigChange';
import type { z } from 'zod';

type UpdateDataLakeParams = z.infer<typeof UpdateDataLakeRequestInput>;

interface UpdateDataLakeAdapters extends LakeConfigAuditAdapters {
  // The event repo is REQUIRED here, unlike the optional shape LakeConfigAuditAdapters carries
  // for recomputeLakeStats: every caller of this service is an API route (there is exactly one
  // per service), so nothing is spared by making it optional and a route that forgot to wire it
  // would go dark silently - the one failure mode an audit must not have. Required here turns
  // that into a compile error.
  db: LakeConfigAuditAdapters['db'] & {
    lakeConfigChangeEvents: NonNullable<LakeConfigAuditAdapters['db']['lakeConfigChangeEvents']>;
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'update'>;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
  };
}

/**
 * Metadata update (name/description/access gate) by the lake's creator or an admin.
 *
 * Gate semantics: an omitted gate field leaves the current value alone, while an empty string
 * clears it. Clearing does NOT make the lake world-readable - an ungated lake falls back to its
 * visibility (private to the owner, org-wide if org-scoped, everyone if public), per
 * Private-by-default in canAccessLake.
 */
export const updateDataLake = async (
  actor: ManageActor,
  dataLakeId: string,
  parameters: UpdateDataLakeParams,
  { db, logger }: UpdateDataLakeAdapters
): Promise<IDataLakeDocument> => {
  const params = secureParameters(parameters, UpdateDataLakeRequestInput);

  const existing = await db.dataLakes.findById(dataLakeId);
  if (!existing) {
    throw new NotFoundError(`Data lake not found`);
  }

  // Loaded once and reused for the audit event's manage rung, rather than calling
  // resolveCanManageLake (which fetches its own): the gate and the rung must agree on the same
  // grant set, and a second fetch could see a grant revoked microseconds later and report a rung
  // that did not authorize this write.
  const grants = await loadActiveLakeGrants(existing, { db });
  if (!canManageLake(existing, actor, grants)) {
    throw new BadRequestError('You do not have permission to update this data lake');
  }

  // Mirror the setLakeVisibility guardrail from the other side so the "public => no gate"
  // invariant can't be broken here: a public lake is truly open, so it must never gain an access
  // gate. Refuse adding requiredUserTag/requiredEntitlement to a public lake (demote to private
  // first). Reads still defend this (defense in depth), but the state would otherwise contradict
  // the "readable by everyone" UI.
  if (existing.isPublic && (params.requiredUserTag || params.requiredEntitlement)) {
    throw new BadRequestError(
      'A public data lake cannot have an access tag or required entitlement. Make it private first, then add the gate.'
    );
  }

  // Normalize the entitlement key at write time (Mongo $in is case-sensitive; the
  // resolver produces lowercase keys). Only override when present so an absent field isn't
  // written as undefined, and so the '' clear-sentinel passes through untouched.
  const writes = {
    ...params,
    ...(params.requiredEntitlement ? { requiredEntitlement: normalizeEntitlementKey(params.requiredEntitlement) } : {}),
  };

  // NO-OP EARLY-OUT, deliberately mirroring setLakeVisibility, which has always had one. A PUT
  // whose every supplied field already holds exactly the value it is setting changed nothing, so
  // it must not write: it would otherwise move `lastUpdatedByUserId` to someone who altered
  // nothing.
  //
  // RAW equality, over the keys the CALLER supplied - deliberately NOT the audit diff. The two
  // answer different questions and must not be conflated: this one is "did the caller ask for
  // something the document does not already say", where the diff is "did a semantically
  // meaningful value move". `diffLakeConfig` normalizes the three spellings of unset
  // (undefined/null/'') onto one value, which is right for a history and WRONG for a write gate -
  // it would make a whitespace-only gate impossible to clear (' ' and '' both normalize to unset,
  // so the clearing PUT would look like a no-op while the stored space still gates the lake), and
  // it would silently drop a write to any field the audit list does not happen to cover.
  const storedValues = existing as unknown as Record<string, unknown>;
  const isNoOp = Object.entries(writes).every(([key, value]) => value === undefined || storedValues[key] === value);
  if (isNoOp) {
    return existing;
  }

  const updated = await db.dataLakes.update({
    id: dataLakeId,
    ...writes,
    // After `params`, never before: the stamp is resolved from the authenticated actor, so it must
    // win over anything a crafted body carried. `secureParameters` already strips unknown keys
    // (UpdateDataLakeRequestInput declares no such field), making this order belt-and-braces.
    ...lakeConfigWriteStamp(actor),
  });

  if (!updated) {
    throw new NotFoundError('Data lake not found after update');
  }

  // Diffed against the INTENDED post-write document, never against `updated`. Both describe this
  // write, but `updated` is whatever the collection happened to hold at that instant: a second
  // writer's `$set` landing between the `findById` above and this update is included in the
  // `findOneAndUpdate` result too, and diffing it would record THAT writer's field changes under
  // THIS caller's principal and manage rung - an audit row naming the wrong person, which is worse
  // than a missing one. The projection is bounded to the keys this caller supplied, so it can only
  // ever describe this caller's own change. Under mongoose `$set` semantics it is also what the
  // write asks for, so nothing real is lost by not reading the result back.
  //
  // Built key-by-key rather than by spreading `writes`, for the same reason the no-op gate skips
  // `undefined` above: a key present with an `undefined` value spreads OVER the existing one and
  // reads as a deliberate clear, inventing a change out of a field the caller merely omitted.
  const projected: Record<string, unknown> = { ...storedValues };
  for (const [key, value] of Object.entries(writes)) {
    if (value !== undefined) projected[key] = value;
  }

  await recordLakeConfigChange(
    {
      actor,
      lake: existing,
      grants,
      action: 'update',
      changes: diffLakeConfig(existing, projected as Partial<IDataLakeDocument>),
    },
    { db, logger }
  );

  return updated;
};

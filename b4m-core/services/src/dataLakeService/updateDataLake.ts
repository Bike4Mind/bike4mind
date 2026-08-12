import type { IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { UpdateDataLakeRequestInput, normalizeEntitlementKey } from '@bike4mind/common';
import { secureParameters, BadRequestError, NotFoundError } from '@bike4mind/utils';
import { canManageLake } from './manageRule';
import type { z } from 'zod';

type UpdateDataLakeParams = z.infer<typeof UpdateDataLakeRequestInput>;

interface UpdateDataLakeAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'update'>;
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
  actor: { userId: string; isAdmin: boolean },
  dataLakeId: string,
  parameters: UpdateDataLakeParams,
  { db }: UpdateDataLakeAdapters
): Promise<IDataLakeDocument> => {
  const params = secureParameters(parameters, UpdateDataLakeRequestInput);

  const existing = await db.dataLakes.findById(dataLakeId);
  if (!existing) {
    throw new NotFoundError(`Data lake not found`);
  }

  if (!canManageLake(existing, actor)) {
    throw new BadRequestError('Only the creator can update this data lake');
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

  const updated = await db.dataLakes.update({
    id: dataLakeId,
    ...params,
    // Normalize the entitlement key at write time (Mongo $in is case-sensitive; the
    // resolver produces lowercase keys). Only override when present so an absent field isn't
    // written as undefined, and so the '' clear-sentinel passes through untouched.
    ...(params.requiredEntitlement ? { requiredEntitlement: normalizeEntitlementKey(params.requiredEntitlement) } : {}),
  });

  if (!updated) {
    throw new NotFoundError('Data lake not found after update');
  }

  return updated;
};

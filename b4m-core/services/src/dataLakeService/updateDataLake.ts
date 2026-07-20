import type { IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { UpdateDataLakeRequestInput, normalizeEntitlementKey } from '@bike4mind/common';
import { secureParameters, BadRequestError, NotFoundError } from '@bike4mind/utils';
import type { z } from 'zod';

type UpdateDataLakeParams = z.infer<typeof UpdateDataLakeRequestInput>;

interface UpdateDataLakeAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'update'>;
  };
}

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

  if (!actor.isAdmin && existing.createdByUserId !== actor.userId) {
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
    // resolver produces lowercase keys). Only override when present so an absent field
    // isn't written as undefined. NOTE: the gate can be set/changed but not CLEARED via this
    // path (zod `.min(3)` also rejects ''); un-gating a lake is a deliberate non-affordance
    // for v1 (the gate is a PHI boundary) - clear via a one-shot if ever needed.
    ...(params.requiredEntitlement ? { requiredEntitlement: normalizeEntitlementKey(params.requiredEntitlement) } : {}),
  });

  if (!updated) {
    throw new NotFoundError('Data lake not found after update');
  }

  return updated;
};

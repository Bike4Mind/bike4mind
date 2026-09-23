import type { IDataLakeAccessGrantRepository, IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { canManageLake, type ManageActor } from './manageRule';
import { loadActiveLakeGrants } from './authorizeLakeManage';
import { lakeConfigWriteStamp } from './lakeConfigWriteStamp';
import { diffLakeConfig } from './diffLakeConfig';
import { recordLakeConfigChange, type LakeConfigAuditAdapters } from './recordLakeConfigChange';

interface DemoteDataLakeAdapters extends LakeConfigAuditAdapters {
  db: LakeConfigAuditAdapters['db'] & {
    lakeConfigChangeEvents: NonNullable<LakeConfigAuditAdapters['db']['lakeConfigChangeEvents']>;
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'demoteToDraft'>;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
  };
}

/**
 * Pull a lake back out of publication - the reverse of `promoteDataLake`, for a lake an owner
 * decides is not ready after all. Owner or admin only, same gate as every other lifecycle
 * door.
 *
 * Only valid from `active`: a lake mid-archive, mid-delete, or already `draft`/`archived`/`deleted`
 * has its own lifecycle door for getting back to `active` (unarchive/restore) before it can be
 * demoted again - demote does not reach across those axes.
 *
 * Safe to run at any time a lake IS active, with nothing to quiesce first: grounding gates on
 * `status === 'active'` LIVE, at retrieval time (`getDynamicDataLakeTags`'s pre-filter and the
 * session-binding check both re-read it per request, never from a cached or session-bound copy),
 * so a demote takes effect on the very next lookup. There is no in-flight retrieval to cancel or
 * reconcile - unlike archive, this door cancels no batch and sweeps no file.
 */
export const demoteDataLake = async (
  actor: ManageActor,
  dataLakeId: string,
  { db, logger }: DemoteDataLakeAdapters
): Promise<IDataLakeDocument> => {
  const existing = await db.dataLakes.findById(dataLakeId);
  if (!existing) {
    throw new NotFoundError('Data lake not found');
  }

  const grants = await loadActiveLakeGrants(existing, { db });
  if (!canManageLake(existing, actor, grants)) {
    throw new BadRequestError('You do not have permission to demote this data lake');
  }

  // Idempotent on the terminal state, matching promoteDataLake's own already-active short-circuit.
  if (existing.status === 'draft') {
    return existing;
  }
  if (existing.status !== 'active') {
    throw new BadRequestError(`Cannot move a data lake in '${existing.status}' status back to draft`);
  }

  const stamp = lakeConfigWriteStamp(actor);
  const demoted = await db.dataLakes.demoteToDraft(dataLakeId, stamp);
  if (!demoted) {
    // Re-read only on the loss path, so the error names the status that actually won rather than
    // the stale one the guard above saw.
    const current = await db.dataLakes.findById(dataLakeId);
    throw new BadRequestError(
      current
        ? `This data lake moved to '${current.status}' while it was being demoted and can no longer be demoted`
        : 'This data lake is no longer available to demote'
    );
  }

  const updated = { ...existing, status: 'draft' as const, ...stamp };
  await recordLakeConfigChange(
    {
      actor,
      lake: existing,
      grants,
      action: 'demote',
      changes: diffLakeConfig(existing, updated),
    },
    { db, logger }
  );

  return updated;
};

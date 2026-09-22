import type { IDataLakeAccessGrantRepository, IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { canManageLake, type ManageActor } from './manageRule';
import { loadActiveLakeGrants } from './authorizeLakeManage';
import { lakeConfigWriteStamp } from './lakeConfigWriteStamp';
import { diffLakeConfig } from './diffLakeConfig';
import { recordLakeConfigChange, type LakeConfigAuditAdapters } from './recordLakeConfigChange';

interface PromoteDataLakeAdapters extends LakeConfigAuditAdapters {
  // Required, not optional - matching archiveDataLake/unarchiveDataLake: every caller of this
  // service is an API route, so a route that forgot to wire the audit repo would go dark
  // silently, which is the one failure mode an audit must not have.
  db: LakeConfigAuditAdapters['db'] & {
    lakeConfigChangeEvents: NonNullable<LakeConfigAuditAdapters['db']['lakeConfigChangeEvents']>;
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'activateIfDraft'>;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
  };
}

/**
 * Publish a draft lake - the explicit, owner-or-admin-only replacement for the old implicit
 * draft -> active flip that used to run as a side effect of adding the lake's first file
 * . Draft is excluded from grounding, so this is the moment a lake starts affecting
 * answers; nothing should cross it without someone choosing to.
 *
 * A single atomic hop, unlike archive/unarchive: there is no side effect to sequence between a
 * claim and a settle (no batches to cancel, no files to sweep), so `activateIfDraft`'s own
 * conditional update IS the whole operation.
 */
export const promoteDataLake = async (
  actor: ManageActor,
  dataLakeId: string,
  { db, logger }: PromoteDataLakeAdapters
): Promise<IDataLakeDocument> => {
  const existing = await db.dataLakes.findById(dataLakeId);
  if (!existing) {
    throw new NotFoundError('Data lake not found');
  }

  const grants = await loadActiveLakeGrants(existing, { db });
  if (!canManageLake(existing, actor, grants)) {
    throw new BadRequestError('You do not have permission to promote this data lake');
  }

  // Idempotent on the terminal state, matching archiveDataLake's own already-archived
  // short-circuit: existing active lakes are unaffected by this door existing at all.
  if (existing.status === 'active') {
    return existing;
  }
  if (existing.status !== 'draft' && existing.status != null) {
    throw new BadRequestError(`Cannot promote a data lake in '${existing.status}' status`);
  }

  const stamp = lakeConfigWriteStamp(actor);
  const activated = await db.dataLakes.activateIfDraft(dataLakeId, stamp);
  if (!activated) {
    // Re-read only on the loss path, so the error names the status that actually won rather than
    // the stale one the guard above saw - a delete or archive can land in the gap between the
    // read above and this write.
    const current = await db.dataLakes.findById(dataLakeId);
    throw new BadRequestError(
      current
        ? `This data lake moved to '${current.status}' while it was being promoted and can no longer be promoted`
        : 'This data lake is no longer available to promote'
    );
  }

  const updated = { ...existing, status: 'active' as const, ...stamp };
  await recordLakeConfigChange(
    {
      actor,
      lake: existing,
      grants,
      action: 'promote',
      changes: diffLakeConfig(existing, updated),
    },
    { db, logger }
  );

  return updated;
};

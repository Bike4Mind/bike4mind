import type { IDataLakeAccessGrantRepository, IDataLakeRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { canManageLake, type ManageActor } from './manageRule';
import { loadActiveLakeGrants } from './authorizeLakeManage';
import { diffLakeConfig } from './diffLakeConfig';
import { recordLakeConfigChange, type LakeConfigAuditAdapters } from './recordLakeConfigChange';

interface AcceptDataLakePurgeAdapters extends LakeConfigAuditAdapters {
  // Required, not optional, for the same reason as restoreDeletedDataLake's: the only caller is an
  // API route, and this is the sole audit record a purge ever produces - a route that forgot to
  // wire it would go dark silently. Required turns that into a compile error.
  db: LakeConfigAuditAdapters['db'] & {
    lakeConfigChangeEvents: NonNullable<LakeConfigAuditAdapters['db']['lakeConfigChangeEvents']>;
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'claimPurging'>;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
  };
}

/**
 * Accept a phase-2 hard delete: claim `deleted -> purging` so the lake leaves the deleted-lakes
 * list and stops offering Restore the moment the purge is accepted, rather than when the background
 * sweep eventually finishes (#1744). Owner or admin only.
 *
 * The caller MUST enqueue the sweep only if this resolves, and MUST NOT if it throws. Before this
 * existed, `POST /lifecycle {action:'cleanup'}` answered 202 after enqueueing alone, leaving the
 * lake in `deleted` - the status the deleted-lakes query selects on - so a second tab still showed
 * Restore on a lake whose destruction was already irreversible, and that Restore SUCCEEDED. Either
 * it landed before the sweep (whose guard then threw, and the consumer swallowed the purge with a
 * WARN), or after (the sweep never re-checks, so the lake was restored and then destroyed anyway).
 *
 * The transition is an atomic claim, and that is the whole substance of the fix: a losing claim
 * means a concurrent restore got there first, so the purge is REFUSED rather than racing it. A
 * plain status write would leave the same bug behind a narrower window, because the restore's own
 * terminal write would clobber `purging` on its way to `active`.
 */
export const acceptDataLakePurge = async (
  actor: ManageActor,
  dataLakeId: string,
  { db, logger }: AcceptDataLakePurgeAdapters
): Promise<void> => {
  const existing = await db.dataLakes.findById(dataLakeId);
  if (!existing) {
    throw new NotFoundError('Data lake not found');
  }
  // Loaded once and reused for the audit event's manage rung: the gate and the recorded rung must
  // agree on one grant set, not two reads that could disagree.
  const grants = await loadActiveLakeGrants(existing, { db });
  if (!canManageLake(existing, actor, grants)) {
    throw new BadRequestError('You do not have permission to clean up this data lake');
  }

  const claimed = await db.dataLakes.claimPurging(dataLakeId);
  if (!claimed) {
    // Lost the claim: between this caller's read and the write, the lake stopped being `deleted` -
    // a concurrent restore, or a purge already accepted by another tab. Refusing is the point;
    // the alternative is two accepted purges, or one that quietly overwrites a restore.
    throw new BadRequestError('Data lake must be soft-deleted before cleanup');
  }

  // Recorded only on the winning claim, so the trail never shows a purge that was refused. This is
  // the only audit record the operation leaves: the sweep records nothing, and it deletes the lake
  // itself, so nothing later can write this event on its behalf.
  await recordLakeConfigChange(
    {
      actor,
      lake: existing,
      grants,
      action: 'purge',
      // Diffed against this write's own field, never a re-read: same reasoning as
      // restoreDeletedDataLake - a concurrent writer's $set landing in the gap would otherwise be
      // recorded under this caller's principal and rung.
      changes: diffLakeConfig(existing, { ...existing, status: 'purging' }),
    },
    { db, logger }
  );
};

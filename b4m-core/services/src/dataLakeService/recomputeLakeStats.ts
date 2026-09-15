import type { IDataLakeDocument, IDataLakeRepository, IFabFileRepository } from '@bike4mind/common';
import { lakeMembershipScope } from './lakeMembershipScope';
import { diffLakeConfig } from './diffLakeConfig';
import { recordLakeConfigChange, type LakeConfigAuditAdapters } from './recordLakeConfigChange';
import type { ManageActor } from './manageRule';

export interface RecomputeLakeStatsAdapters extends LakeConfigAuditAdapters {
  db: LakeConfigAuditAdapters['db'] & {
    dataLakes: Pick<IDataLakeRepository, 'setStats' | 'activateIfDraft'>;
    fabFiles: Pick<IFabFileRepository, 'computeDataLakeStats'>;
  };
}

/**
 * Recomputes a lake's authoritative fileCount/totalSizeBytes from the SOURCE file records and
 * persists them - never from running batch counters. Called at batch completion, on the reconcile
 * read path, and by every door that changes a file's membership, so transient counter drift
 * self-heals.
 *
 * Takes the lake document rather than an id + tag so the membership scope is derived here, and
 * every caller reaches it. That matters most at batch completion, the busiest writer of
 * fileCount: a caller left on a narrower scope would write a different count than the lifecycle
 * paths, and the stored value would flip depending on which one ran last.
 *
 * Also carries the draft -> active transition, because a lake with members is by definition no
 * longer a draft and this is where the membership doors converge (see
 * `recomputeStatsForLakeTags` for the file-write ones). Sitting on the doors instead, it reached
 * only the upload wizard, which is why a lake filled any other way never got to Discover.
 *
 * `skipActivation` lets a caller keep fileCount/totalSizeBytes accurate without risking the
 * publish side effect - for a prefix-arm join, membership itself is granted automatically (the
 * read-side predicate has no permission check), but activating a draft lake is a one-way,
 * visibility-changing action. This function does no authorization itself; a caller that cannot
 * establish the actor manages the lake (see canManageLake in toggleTags.ts/reconcileLakeTags.ts)
 * passes `skipActivation: true` rather than choosing between publishing to an unauthorized actor
 * or leaving stats stale indefinitely.
 *
 * `actor` is OPTIONAL and used for one thing only: naming the principal on the config-change event
 * the draft -> active flip emits. It takes no REQUIRED actor by design (see
 * IDataLake.lastUpdatedByUserId, "unattributed by design") - a tag edit, a file toggle or a batch
 * completion drives it, and the batch doors genuinely do not know who is behind the change by the
 * time they reach here. The tag doors DO know, and pass it. A caller that does not supply one
 * records the flip under a `system` principal - the honest answer rather than an invented one.
 */
export const recomputeLakeStats = async (
  lake: Pick<IDataLakeDocument, 'id' | 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId' | 'organizationId'> &
    Partial<Pick<IDataLakeDocument, 'status'>>,
  { db, logger }: RecomputeLakeStatsAdapters,
  opts?: { skipActivation?: boolean; actor?: ManageActor }
): Promise<{ fileCount: number; totalSizeBytes: number; totalChunkedChars: number }> => {
  const stats = await db.fabFiles.computeDataLakeStats(lakeMembershipScope(lake));
  await db.dataLakes.setStats(lake.id, stats);
  // Emptying a lake never sends it back to draft - the transition is one-way, so a lake the owner
  // has already published stays published while they swap its contents.
  if (!opts?.skipActivation && stats.fileCount > 0) {
    // Read before the flip, since afterwards the document says 'active' either way.
    const priorStatus = lake.status;
    const activated = await db.dataLakes.activateIfDraft(lake.id);
    // Only on a real flip: `activateIfDraft` is a conditional update that returns false for a lake
    // already active, and every recompute on an active lake calls it. Recording unconditionally
    // would put a status row in the history on every file upload.
    if (activated) {
      await recordLakeConfigChange(
        {
          actor: opts?.actor ?? { userId: '', isAdmin: false },
          lake,
          action: 'auto-activate',
          // The two-field form rather than a document diff, because `lake` is a narrow Pick.
          //
          // `before` is asserted ONLY when the caller's copy actually says 'draft'. activateIfDraft
          // matches `status: { $in: ['draft', null] }`, so it also flips a lake written before the
          // field existed, whose status was never 'draft' at all - hardcoding it would put a value
          // in the audit that was never on the document. An absent `before` reads as "unset", which
          // is exactly right for that lake and honest for a caller holding a stale copy. Every
          // unlisted field compares unset-to-unset, so this still yields the one status row.
          changes: diffLakeConfig(priorStatus === 'draft' ? { status: 'draft' } : {}, { status: 'active' }),
          // ALWAYS `system`, even when an actor is threaded: the rung records what AUTHORIZED the
          // write, and nothing did - `activateIfDraft` runs no authorization check at all (see the
          // skipActivation note above). The actor, when known, is recorded as the principal; it was
          // never the thing that permitted this.
          manageRung: 'system',
        },
        { db, logger }
      );
    }
  }
  return stats;
};

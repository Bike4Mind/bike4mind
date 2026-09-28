import { researchRunChange } from '../dataLakeService/diffLakeConfig';
import {
  recordLakeConfigChange,
  type LakeConfigAuditAdapters,
  type LakeConfigAuditLakeRef,
} from '../dataLakeService/recordLakeConfigChange';

export interface ResearchRunOutcomeAdapters extends LakeConfigAuditAdapters {
  db: LakeConfigAuditAdapters['db'] & {
    // REQUIRED - see the matching note on ResearchConfigAdapters/StartResearchRunAdapters.
    lakeConfigChangeEvents: NonNullable<LakeConfigAuditAdapters['db']['lakeConfigChangeEvents']>;
  };
}

/**
 * Records a run reaching an outcome - the History-tab half of "run start and outcome" that
 * `start-research-run` (recorded in `startResearchRun.ts`) covers the other half of.
 *
 * Called from `runLakeResearch.ts`, the background executor - there is no session behind a queued
 * run (a scheduled v2 run has none at all), so this always records under the `system` rung (the
 * same rung `membership-succession` stamps, and the retired `auto-activate` did - unlike
 * `membership-succession`, which keeps the triggering user as principal, there is no principal at
 * all here). The blank `userId` is what makes `recordLakeConfigChange` derive `principalKind:
 * 'system'` on its own; passing `manageRung: 'system'` explicitly on top means the audit reads
 * correctly even if a `createdByUserId` happens to collide with the empty string (it cannot in
 * practice, but the override is what makes that a non-question rather than an assumption).
 *
 * Takes NO grants: `manageRung` is always the explicit `'system'` override above, and
 * `recordLakeConfigChange` only resolves a rung from grants when none is given - so a grants read
 * here would query for a value nothing ever reads. It would also run OUTSIDE
 * `recordLakeConfigChange`'s own best-effort try/catch, so its failure would reject this whole
 * call - which, from `runLakeResearch.ts`'s `Promise.all` in `recordRunEffects`, could re-settle an
 * already-completed run as failed, or leave a failed run stuck `running` forever. Pinned by
 * `recordResearchRunOutcome.test.ts`'s best-effort test.
 */
export async function recordResearchRunOutcome(
  lake: LakeConfigAuditLakeRef,
  query: string,
  outcome: 'completed' | 'failed',
  { db, logger }: ResearchRunOutcomeAdapters
): Promise<void> {
  await recordLakeConfigChange(
    {
      actor: { userId: '', isAdmin: false, administeredOrgIds: [] },
      lake,
      manageRung: 'system',
      action: 'complete-research-run',
      changes: [researchRunChange(query, outcome)],
    },
    { db, logger }
  );
}

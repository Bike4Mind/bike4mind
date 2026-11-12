import { Migration } from '@bike4mind/database';
import { DEFAULT_RUN_MS, verifyLegacyQuestPlanCoverage, type CoverageCounts } from '../legacyQuestPlanConversion';
import { type MigrationFile } from './index';
import RefreshLegacyQuestPlanFiles from './20260921241025_refresh-legacy-quest-plan-files';

const uncovered = (label: string, c: CoverageCounts): string =>
  `${label}: ${c.missing} missing, ${c.stale} stale${c.uncoveredSamples.length ? ` (sample: ${c.uncoveredSamples.join(', ')})` : ''}`;

/**
 * Checks that every non-empty, owned legacy plan and graph has an up-to-date file, once
 * RefreshLegacyQuestPlanFiles (20260921241025) has refreshed them. Reads the legacy collections
 * only; removing them is a separate step that relies on this check passing.
 */
const migration: MigrationFile = {
  // Backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), which must sort
  // last. The runner stops at the first throw, so a coverage failure also holds back every pending
  // id above this one: today only 20260922000000/1, plus any migration later backdated in between.
  id: 20260921249990,
  name: 'verify legacy quest plan file coverage',

  up: async ctx => {
    // The runner moves on past a pending migration, so this runs even when the refresh did not
    // finish; checking then would fail on sources the refresh has yet to reach.
    if (!(await Migration.exists({ id: RefreshLegacyQuestPlanFiles.id }))) {
      return { incomplete: true, reason: 'waiting for the legacy quest plan refresh to finish' };
    }
    const deadline = new Date((ctx?.startedAt ?? new Date()).getTime() + DEFAULT_RUN_MS);
    const { plans, graphs, stoppedEarly, covered } = await verifyLegacyQuestPlanCoverage({ logger: console, deadline });
    if (stoppedEarly) return { incomplete: true, reason: 'ran out of time before verifying every source' };
    console.info(
      `Legacy quest plan coverage: plans=${plans.expected} planFiles=${plans.files} graphs=${graphs.expected} graphFiles=${graphs.files}` +
        // Sources with no live owner cannot have a file; surfaced so they are not dropped unseen.
        ` plansWithoutOwner=${plans.skippedNoOwner} graphsWithoutOwner=${graphs.skippedNoOwner}`
    );
    // A completed refresh that still leaves a source without a current file will not fix itself
    // on a retry, so this fails the run instead of staying pending.
    if (!covered) {
      throw new Error(
        `Legacy quest plan coverage check failed. ${uncovered('plans', plans)}; ${uncovered('graphs', graphs)}`
      );
    }
  },

  // The files belong to their owners now, and the legacy rows are removed separately.
  down: async () => {},
};

export default migration;

import { filesArchiveStorage } from '../legacyQuestPlanArchiveStorage';
import {
  convertLegacyQuestPlans,
  DEFAULT_RUN_MS,
  verifyLegacyQuestPlanCoverage,
  type CoverageCounts,
} from '../legacyQuestPlanConversion';
import { type MigrationFile } from './index';

const uncovered = (label: string, c: CoverageCounts): string =>
  `${label}: ${c.missing} missing, ${c.stale} stale${c.uncoveredSamples.length ? ` (sample: ${c.uncoveredSamples.join(', ')})` : ''}`;

/**
 * Final pass of ConvertLegacyQuestPlansToFiles (20260921239990), run now that nothing writes the
 * legacy plans and graphs any more: refreshes the files whose source was edited after the first
 * pass, then checks that every non-empty, owned plan and graph has an up-to-date file. Reads the
 * legacy collections only; removing them is a separate step that relies on this check passing.
 */
const migration: MigrationFile = {
  // Backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), which must sort
  // last. The runner stops at the first throw, so a coverage failure also holds back every pending
  // id above this one: today only 20260922000000/1, plus any migration later backdated in between.
  id: 20260921241030,
  name: 'refresh legacy quest plan files and verify coverage',

  up: async ctx => {
    const now = new Date();
    const deadline = new Date((ctx?.startedAt ?? now).getTime() + DEFAULT_RUN_MS);
    const converted = await convertLegacyQuestPlans({ storage: filesArchiveStorage(), logger: console, now, deadline });
    // Transient outcomes stay pending so the next deploy retries, as in the first pass.
    const failed = converted.plans.failed + converted.graphs.failed;
    if (converted.stoppedEarly) return { incomplete: true, reason: 'ran out of time before visiting every source' };
    if (failed > 0) return { incomplete: true, reason: `${failed} source(s) failed to convert` };

    const { plans, graphs, stoppedEarly, covered } = await verifyLegacyQuestPlanCoverage({ logger: console, deadline });
    if (stoppedEarly) return { incomplete: true, reason: 'ran out of time before verifying every source' };
    console.info(
      `Legacy quest plan coverage: plans=${plans.expected} planFiles=${plans.files} graphs=${graphs.expected} graphFiles=${graphs.files}` +
        // Sources with no live owner cannot have a file; surfaced so they are not dropped unseen.
        ` plansWithoutOwner=${plans.skippedNoOwner} graphsWithoutOwner=${graphs.skippedNoOwner}`
    );
    // A clean conversion pass that still leaves a source without a current file will not fix itself
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

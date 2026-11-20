import { filesArchiveStorage } from '../legacyQuestPlanArchiveStorage';
import { convertLegacyQuestPlans, DEFAULT_RUN_MS } from '../legacyQuestPlanConversion';
import { type MigrationFile } from './index';

/**
 * Final pass of ConvertLegacyQuestPlansToFiles (20260921239990), run now that nothing writes the
 * legacy plans and graphs any more: refreshes the files whose source was edited after the first
 * pass. VerifyLegacyQuestPlanFiles (20260921249990) checks coverage once this one is applied; they
 * are separate ids so each full walk gets the whole run budget on its own deploy if it needs it.
 */
const migration: MigrationFile = {
  // Backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), which must sort last.
  id: 20260921241025,
  name: 'refresh legacy quest plan files',

  up: async ctx => {
    const now = new Date();
    const deadline = new Date((ctx?.startedAt ?? now).getTime() + DEFAULT_RUN_MS);
    const { plans, graphs, stoppedEarly } = await convertLegacyQuestPlans({
      storage: filesArchiveStorage(),
      logger: console,
      now,
      deadline,
    });
    // Transient outcomes stay pending so the next deploy retries, as in the first pass.
    const failed = plans.failed + graphs.failed;
    if (stoppedEarly) return { incomplete: true, reason: 'ran out of time before visiting every source' };
    if (failed > 0) return { incomplete: true, reason: `${failed} source(s) failed to convert` };
  },

  // The files belong to their owners now, and the legacy rows are removed separately.
  down: async () => {},
};

export default migration;

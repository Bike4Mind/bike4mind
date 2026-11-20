import { filesArchiveStorage } from '../legacyQuestPlanArchiveStorage';
import { convertLegacyQuestPlans, DEFAULT_RUN_MS } from '../legacyQuestPlanConversion';
import { type MigrationFile } from './index';

/**
 * Writes each live, non-empty legacy QuestMaster plan (v4) and graph (v5) as one markdown file
 * owned by its owner, exempt from the storage quota. The conversion is in
 * ../legacyQuestPlanConversion.ts so a later pass can reuse it under a new migration id.
 */
const migration: MigrationFile = {
  // Backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), which must sort last.
  id: 20260921239990,
  name: 'convert legacy quest plans and graphs to markdown files',

  up: async ctx => {
    const storage = filesArchiveStorage();
    const now = new Date();
    const deadline = new Date((ctx?.startedAt ?? now).getTime() + DEFAULT_RUN_MS);
    const { plans, graphs, stoppedEarly } = await convertLegacyQuestPlans({ storage, logger: console, now, deadline });
    // Not recorded as applied until a pass visits every source without a failure, so the next
    // deploy re-runs it: converted sources are skipped cheaply, so it picks up where this pass stopped.
    const failed = plans.failed + graphs.failed;
    if (stoppedEarly) return { incomplete: true, reason: 'ran out of time before visiting every source' };
    if (failed > 0) return { incomplete: true, reason: `${failed} source(s) failed to convert` };
  },

  // The files belong to their owners now, and the legacy rows are removed separately.
  down: async () => {},
};

export default migration;

import { userRepository } from '@bike4mind/database';
import { corpusRoot, runHelpDatalakeIngest } from '@workers/cron/helpDatalakeIngest';
import type { SelfHostWorker } from './selfHostWorker';

/** Matches the hosted helpDatalakeIngest cron's rate(6 hours) in infra/cron.ts. */
export const HELP_DATALAKE_INGEST_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * Self-host counterpart of the hosted helpDatalakeIngest cron. Runs on startup too, so a fresh
 * install gets its help lake without waiting six hours. Unlike hosted, it bootstraps a lake that has
 * never existed, owned by the oldest admin, because self-host has no operator to run the script.
 */
export function registerHelpDatalakeIngest(worker: SelfHostWorker): void {
  worker.registerScheduledTask(
    'helpDatalakeIngest',
    HELP_DATALAKE_INGEST_INTERVAL_MS,
    async () => {
      await runHelpDatalakeIngest({
        corpusRoot: corpusRoot(),
        bootstrapOwnerId: () => userRepository.findOldestActiveAdminId(),
      });
    },
    { runOnStartup: true }
  );
}

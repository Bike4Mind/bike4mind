import { runLakeConnectorOrphanReap } from '@workers/cron/lakeConnectorOrphanReap';
import type { SelfHostWorker } from './selfHostWorker';

/** Matches the hosted lakeConnectorOrphanReap cron's rate(1 day) in infra/cron.ts. */
export const LAKE_CONNECTOR_ORPHAN_REAP_INTERVAL_MS = 24 * 60 * 60_000;

export function registerLakeConnectorOrphanReap(worker: SelfHostWorker): void {
  worker.registerScheduledTask('lakeConnectorOrphanReap', LAKE_CONNECTOR_ORPHAN_REAP_INTERVAL_MS, async () => {
    await runLakeConnectorOrphanReap();
  });
}

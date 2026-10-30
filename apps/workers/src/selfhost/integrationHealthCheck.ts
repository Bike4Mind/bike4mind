import type { Logger } from '@bike4mind/observability';
import { runAllProbes } from '@bike4mind/server-utils/services/integrationHealthService';
import type { SelfHostWorker } from './selfHostWorker';

/** Matches the hosted integrationHealthCheck cron's rate(5 minutes) in infra/cron.ts. */
export const INTEGRATION_HEALTH_CHECK_INTERVAL_MS = 5 * 60_000;

export function registerIntegrationHealthCheck(worker: SelfHostWorker, logger: Logger): void {
  worker.registerScheduledTask('integrationHealthCheck', INTEGRATION_HEALTH_CHECK_INTERVAL_MS, async () => {
    await runAllProbes(logger, { emitMetrics: false });
  });
}

import type { DiscoveryRunHost } from '@bike4mind/common';
import { whenCatalogSeeded } from '@bike4mind/database';
import { modelDiscoveryService } from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';
import { buildModelDiscoveryAdapters } from './adapters';

/** Worker cadence (sec 6.2); also the staleness threshold for the startup leg. */
export const MODEL_DISCOVERY_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * One scheduled discovery run. The hosted cron handler and the self-host
 * worker's scheduled task both come through here, so "the two drivers run the
 * same thing" is a property of the code rather than of review discipline.
 *
 * Everything that decides whether a run does anything - the enableModelDiscovery
 * setting, the lease, the per-source minimum interval, the deadline - lives in
 * the service. A driver contributes wiring and a label, nothing else.
 */
export async function runScheduledDiscovery(
  logger: Logger,
  host: DiscoveryRunHost,
  options: { trigger?: 'cron' | 'manual'; budgetMs?: number } = {}
): Promise<modelDiscoveryService.ModelDiscoveryRunResult> {
  // On a fresh database the boot seed and the first run race, and the run
  // plans against a half-inserted catalog (observed live: 23 join targets
  // instead of 113). Settled - not necessarily succeeded - is enough: a failed
  // seed degrades to the adapter tables, which is a stable baseline too.
  await whenCatalogSeeded();
  return modelDiscoveryService.runModelDiscovery(buildModelDiscoveryAdapters(logger), {
    trigger: options.trigger ?? 'cron',
    host,
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
  });
}

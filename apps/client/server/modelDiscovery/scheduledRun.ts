import type { DiscoveryRunHost } from '@bike4mind/common';
import { whenCatalogSeeded } from '@bike4mind/database';
import { modelDiscoveryService } from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';
import { buildModelDiscoveryAdapters } from './adapters';

/** Worker cadence (sec 6.2); also the staleness threshold for the startup leg. */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;
/** Floor, so a mistyped override cannot turn the fan-out into a hot loop. */
const MIN_INTERVAL_MS = 15 * 60_000;
/** Cap on the boot-seed wait; an unsettled seed must not wedge the driver forever. */
const CATALOG_SEED_WAIT_MS = 60_000;

export const MODEL_DISCOVERY_INTERVAL_ENV = 'MODEL_DISCOVERY_INTERVAL_MS';

/** Read at call time, not module load, so a test (or a re-exec) sees the current env. */
export function modelDiscoveryIntervalMs(): number {
  const raw = process.env[MODEL_DISCOVERY_INTERVAL_ENV];
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, parsed);
}

/**
 * Wait for the boot catalog seed, bounded. On a fresh database the seed and the
 * first run race, and the run plans against a half-inserted catalog (observed
 * live: 23 join targets instead of 113). Settled - not necessarily succeeded -
 * is enough: a failed seed degrades to the adapter tables, a stable baseline.
 *
 * The bound is what keeps a seed that never settles from parking the worker's
 * interval task for the life of the container.
 */
export async function awaitCatalogSeed(logger: Logger): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), CATALOG_SEED_WAIT_MS);
  });
  try {
    const outcome = await Promise.race([whenCatalogSeeded().then(() => 'settled' as const), timedOut]);
    if (outcome === 'timeout') {
      logger.warn(`[model-discovery] catalog seed unsettled after ${CATALOG_SEED_WAIT_MS}ms; running against it as-is`);
    }
  } finally {
    clearTimeout(timer);
  }
}

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
  await awaitCatalogSeed(logger);
  return modelDiscoveryService.runModelDiscovery(buildModelDiscoveryAdapters(logger), {
    trigger: options.trigger ?? 'cron',
    host,
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
  });
}

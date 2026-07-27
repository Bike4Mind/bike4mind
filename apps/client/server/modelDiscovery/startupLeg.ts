/**
 * The startup discovery leg (spec 6.4).
 *
 * `registerScheduledTask` arms an interval and nothing else, so a freshly
 * booted worker would otherwise wait a full interval before its first run. This
 * covers the fresh boot, and only that.
 *
 * B4M_DISCOVERY_DRIVER gates the whole of discovery on a long-lived process -
 * this leg and the recurring interval task alike (server/worker/main.ts) - so
 * an install that never sets it makes no discovery request at all.
 *
 * Not B4M_SELF_HOST. "Is this a self-host install" and "is this process allowed
 * to drive discovery" are different questions, and a hosted long-lived
 * container would silently answer the first one yes. It also disposes of the
 * preview-stage problem: a fresh preview database has no successful run, which
 * passes any staleness gate, so without an explicit flag every preview stage
 * would fan out to every provider on first boot.
 *
 * connectDB never triggers this. A fire-and-forget run from a lambda is frozen
 * the moment the response returns, leaving a claimed lease that only expires -
 * blocking the next genuine attempt for the full TTL.
 */

import type { DiscoveryRunHost } from '@bike4mind/common';
import { modelDiscoveryRunRepository } from '@bike4mind/database';
import { modelDiscoveryService } from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';
import { buildModelDiscoveryAdapters } from './adapters';
import { awaitCatalogSeed, modelDiscoveryIntervalMs } from './scheduledRun';

export const DISCOVERY_DRIVER_ENV = 'B4M_DISCOVERY_DRIVER';

/**
 * Whether this process may drive discovery at all. Read by every discovery
 * entry point on a long-lived process, so the flag is one opt-in rather than a
 * per-leg one; unset means no scheduled run, no startup run, no egress.
 */
export function isDiscoveryDriver(): boolean {
  return process.env[DISCOVERY_DRIVER_ENV] === 'true';
}

export interface StartupLegOptions {
  logger: Logger;
  /**
   * Which deployment the run report is labelled with. Defaults to the
   * deployment flag, not the driver flag: B4M_SELF_HOST says what kind of
   * install this is, B4M_DISCOVERY_DRIVER says whether this process may drive.
   */
  host?: DiscoveryRunHost;
  /** Freshness threshold; a successful run newer than this means nothing to do. */
  intervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

/**
 * Run discovery once at boot when nothing recent has. Returns the reason it
 * declined, or 'ran' - callers fire and forget, tests read the reason.
 *
 * The staleness check is deliberately host-agnostic: a hosted cron run leaves
 * the catalog just as fresh as a worker run, and re-fetching every provider
 * because a different host did the work is exactly the fan-out this gate
 * exists to prevent. The lease inside runModelDiscovery is what makes the
 * remaining race (two containers booting together) a no-op for the loser.
 */
export async function runDiscoveryOnStartup(
  options: StartupLegOptions
): Promise<'ran' | 'not-a-driver' | 'recently-run'> {
  const { logger } = options;
  if (!isDiscoveryDriver()) return 'not-a-driver';

  // A fresh database seeds its catalog on this same boot; running before that
  // settles plans against a half-inserted catalog (see awaitCatalogSeed).
  await awaitCatalogSeed(logger);

  const host: DiscoveryRunHost = options.host ?? (process.env.B4M_SELF_HOST === 'true' ? 'selfhost' : 'hosted');

  const intervalMs = options.intervalMs ?? modelDiscoveryIntervalMs();
  const now = options.now?.() ?? new Date();

  const lastSuccess = await modelDiscoveryRunRepository.lastSuccessfulRun();
  const lastAt = lastSuccess?.startedAt ? new Date(lastSuccess.startedAt).getTime() : null;
  if (lastAt !== null && now.getTime() - lastAt < intervalMs) {
    logger.info(`[model-discovery] startup leg skipped: last successful run was ${now.getTime() - lastAt}ms ago`);
    return 'recently-run';
  }

  logger.info('[model-discovery] startup leg running (no recent successful run)');
  const result = await modelDiscoveryService.runModelDiscovery(buildModelDiscoveryAdapters(logger), {
    trigger: 'startup',
    host,
  });
  logger.info(`[model-discovery] startup leg finished: ${result.outcome}`);
  return 'ran';
}

/**
 * Non-blocking wrapper for a boot path that must not wait on discovery. The
 * run's own lease is released on every terminal outcome, so a failure here
 * costs one log line rather than a stuck lease.
 *
 * Returns a promise that never rejects, so a shutdown path can await it: a run
 * abandoned mid-flight by process.exit leaves its lease held until the TTL and
 * its run document at the pessimistic 'failed' placeholder.
 */
export function startDiscoveryOnStartup(options: StartupLegOptions): Promise<void> {
  return runDiscoveryOnStartup(options).then(
    () => {},
    (error: unknown) => {
      options.logger.error('[model-discovery] startup leg failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  );
}

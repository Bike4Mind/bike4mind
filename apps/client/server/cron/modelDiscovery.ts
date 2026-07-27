/**
 * Hosted model-discovery driver (spec 6.1).
 *
 * A thin driver over `runModelDiscovery`: it wires the deployment's
 * repositories and credentials, runs, and publishes the run's counters. Every
 * decision the run makes - whether discovery is enabled, whether the lease is
 * free, which sources are due, what gets written - belongs to the service, so
 * this handler and the self-host worker closure cannot drift apart.
 *
 * The separate-function + `event` shape mirrors attackSimulation: an admin
 * "Run now" can InvokeAsync the same ARN with `{ trigger: 'manual' }`.
 */

import type { Context } from 'aws-lambda';
import { connectDB } from '@bike4mind/database';
import { modelDiscoveryService } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { emitDiscoveryMetrics, emitDiscoveryRunFailure } from '@server/modelDiscovery/metrics';
import { runScheduledDiscovery } from '@server/modelDiscovery/scheduledRun';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'modelDiscovery' } });

/** The label this driver stamps on its runs and on every metric datum. */
const HOST = 'hosted';

/**
 * Time the run's deadline leaves between itself and the invocation's hard stop,
 * for the commit that follows the deadline and for the lease release after it.
 * The deadline clock starts inside the run - after connectDB, the boot seed and
 * the run-doc create - so a cold start can eat minutes before it is even set.
 */
const BUDGET_HEADROOM_MS = 60_000;
/** A nearly-expired invocation still gets a coherent deadline, not a negative one. */
const MIN_BUDGET_MS = 60_000;

interface ModelDiscoveryEvent {
  /** 'cron' from the schedule, 'manual' from an admin invocation. */
  trigger?: 'cron' | 'manual';
}

/** Optional so a direct call (tests, a non-Lambda driver) falls back to the service default. */
function budgetFrom(context?: Context): number {
  const remainingMs = context?.getRemainingTimeInMillis?.();
  if (remainingMs === undefined) return modelDiscoveryService.DEFAULT_BUDGET_MS;
  return Math.min(modelDiscoveryService.DEFAULT_BUDGET_MS, Math.max(MIN_BUDGET_MS, remainingMs - BUDGET_HEADROOM_MS));
}

export async function handler(event: ModelDiscoveryEvent = {}, context?: Context) {
  const stage = Resource.App.stage;
  try {
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage), logger);

    const result = await runScheduledDiscovery(logger, HOST, {
      trigger: event.trigger === 'manual' ? 'manual' : 'cron',
      budgetMs: budgetFrom(context),
    });

    // A skipped run did nothing and wrote no run document; emitting its zeros
    // would make a lease contention look like a discovery that found nothing.
    if (result.outcome !== 'skipped') await emitDiscoveryMetrics(result, stage, HOST);

    logger.info('[model-discovery] run complete', {
      outcome: result.outcome,
      skipReason: result.skipReason,
      runId: result.runId,
      mode: result.mode,
      discovered: result.metrics.ModelsDiscovered,
      promoted: result.metrics.ModelsPromoted,
      blockedByDispatch: result.metrics.ModelsBlockedByDispatch,
      durationMs: result.metrics.RunDuration,
    });

    return { statusCode: 200, body: JSON.stringify({ outcome: result.outcome, runId: result.runId }) };
  } catch (error) {
    // An unreachable Mongo or a throw inside the run never reaches the result
    // mapping, so the staleness alarm would never see the worst failures.
    // Best-effort: a failed emission must not replace the original error.
    await emitDiscoveryRunFailure(stage, HOST).catch(() => {});
    logger.error('[model-discovery] run threw', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

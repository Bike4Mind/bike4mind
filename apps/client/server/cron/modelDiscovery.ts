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

import { connectDB } from '@bike4mind/database';
import { modelDiscoveryService } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { emitDiscoveryMetrics } from '@server/modelDiscovery/metrics';
import { runScheduledDiscovery } from '@server/modelDiscovery/scheduledRun';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'modelDiscovery' } });

interface ModelDiscoveryEvent {
  /** 'cron' from the schedule, 'manual' from an admin invocation. */
  trigger?: 'cron' | 'manual';
}

export async function handler(event: ModelDiscoveryEvent = {}) {
  const stage = Resource.App.stage;
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage), logger);

  const result = await runScheduledDiscovery(logger, 'hosted', {
    trigger: event.trigger === 'manual' ? 'manual' : 'cron',
    // The lambda timeout is the hard stop; the service's global deadline sits
    // inside it so a partial commit still has room to finish.
    budgetMs: modelDiscoveryService.DEFAULT_BUDGET_MS,
  });

  // A skipped run did nothing and wrote no run document; emitting its zeros
  // would make a lease contention look like a discovery that found nothing.
  if (result.outcome !== 'skipped') await emitDiscoveryMetrics(result, stage);

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
}

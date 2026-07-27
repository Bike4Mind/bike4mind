import { baseApi } from '@server/middlewares/baseApi';
import { adminSettingsRepository, modelDiscoveryRunRepository } from '@bike4mind/database';
import type { IModelDiscoveryRun } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { ForbiddenError } from '@server/utils/errors';
import { DiscoveryDispatchUnavailableError, dispatchDiscoveryRunNow } from '@server/modelDiscovery/runNow';

/**
 * Discovery status card and its "Run now" (spec sec 7).
 *
 * GET  -> the last run's outcome plus the two settings that decide what a run
 *         is allowed to do, so an operator can read "did it work, and would it
 *         have written anything" off one card.
 * POST -> trigger a run on whichever driver this deployment has.
 *
 * The run document is trimmed here rather than in the card: the full document
 * carries every changed model id and every unmatched id, which is a report, not
 * a status line.
 */

const logger = new Logger({ metadata: { service: 'model-discovery-admin' } });

/** Change ids are counted, not listed - the card shows scale, the run doc has the detail. */
const countChanges = (changes: IModelDiscoveryRun['changes']) => ({
  added: changes?.added?.length ?? 0,
  promoted: changes?.promoted?.length ?? 0,
  deprecated: changes?.deprecated?.length ?? 0,
  repriced: changes?.repriced?.length ?? 0,
  flagged: changes?.flagged?.length ?? 0,
});

const trimRun = (run: IModelDiscoveryRun) => ({
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  trigger: run.trigger,
  host: run.host,
  status: run.status,
  sources: (run.sources ?? []).map(source => ({
    name: source.name,
    ok: source.ok,
    durationMs: source.durationMs,
    ...(source.error ? { error: source.error } : {}),
  })),
  joinCoverage: run.joinCoverage ?? [],
  changes: countChanges(run.changes),
});

const handler = baseApi()
  .get(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');

    const [lastRun, lastSuccessful, mode, autoEnable] = await Promise.all([
      modelDiscoveryRunRepository.latestRun(),
      modelDiscoveryRunRepository.lastSuccessfulRun(),
      adminSettingsRepository.getSettingsValue('modelDiscoveryMode'),
      adminSettingsRepository.getSettingsValue('modelDiscoveryAutoEnable'),
    ]);

    return res.json({
      lastRun: lastRun ? trimRun(lastRun) : null,
      lastSuccessfulRunAt: lastSuccessful?.startedAt ?? null,
      mode: mode ?? 'report',
      autoEnable: autoEnable ?? 'priced',
      selfHost: process.env.B4M_SELF_HOST === 'true',
    });
  })
  .post(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');

    try {
      // No debounce: the service's lease turns a concurrent trigger into a
      // 'skipped' run, so the only cost of a double-click is a second log line.
      const { dispatched } = await dispatchDiscoveryRunNow(logger);
      return res.status(202).json({ dispatched });
    } catch (error) {
      if (error instanceof DiscoveryDispatchUnavailableError) {
        logger.error('[model-discovery] run now unavailable', { error: error.message });
        return res.status(503).json({ message: error.message });
      }
      throw error;
    }
  });

export default handler;

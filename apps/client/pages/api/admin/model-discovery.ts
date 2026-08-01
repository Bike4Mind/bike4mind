import { baseApi } from '@server/middlewares/baseApi';
import { adminSettingsRepository, modelDiscoveryRunRepository } from '@bike4mind/database';
import type { IModelDiscoveryRun } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { DiscoveryDispatchUnavailableError, dispatchDiscoveryRunNow } from '@server/modelDiscovery/runNow';

/**
 * Discovery status card, its run history and its "Run now" (spec sec 7).
 *
 * GET          -> the last run's outcome plus the settings that decide whether a
 *                 run happens at all and what it is allowed to do, so an operator
 *                 can read "did it work, and would it have written anything" off
 *                 one card, plus the recent runs the 6h cron would otherwise
 *                 erase from view.
 * GET ?runId=  -> that one run in full.
 * POST         -> trigger a run on whichever driver this deployment has.
 *
 * The listed runs are trimmed here rather than in the card: the full document
 * carries every changed model id and every unmatched id, which is a report, not
 * a status line. The runId branch is that report.
 */

const logger = new Logger({ metadata: { service: 'model-discovery-admin' } });

/** Runs on the list, newest first. Enough to cover several days of the 6h cron. */
const RUN_LIST_LIMIT = 20;

/** Change ids are counted, not listed - the card shows scale, the run doc has the detail. */
const countChanges = (changes: IModelDiscoveryRun['changes']) => ({
  added: changes?.added?.length ?? 0,
  promoted: changes?.promoted?.length ?? 0,
  deprecated: changes?.deprecated?.length ?? 0,
  repriced: changes?.repriced?.length ?? 0,
  flagged: changes?.flagged?.length ?? 0,
});

const listRun = (run: IModelDiscoveryRun) => ({
  id: run.id,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  trigger: run.trigger,
  host: run.host,
  status: run.status,
  // The run's OWN mode, not the modelDiscoveryMode setting below: the setting can
  // change between the run and this read, and a report-mode run's counts are a
  // plan it deliberately did not write. Undefined on runs written before it existed.
  mode: run.mode,
  changes: countChanges(run.changes),
});

const trimRun = (run: IModelDiscoveryRun) => ({
  ...listRun(run),
  sources: (run.sources ?? []).map(source => ({
    name: source.name,
    ok: source.ok,
    durationMs: source.durationMs,
    ...(source.error ? { error: source.error } : {}),
  })),
  joinCoverage: run.joinCoverage ?? [],
});

/**
 * One run as the report. Every array is defaulted so the client never guards for
 * undefined, and the source validators (etag, contentHash, parserRows) stay off
 * it: they are the run-over-run parser-shift guard's data, not an operator's.
 */
const fullRun = (run: IModelDiscoveryRun) => ({
  id: run.id,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  trigger: run.trigger,
  host: run.host,
  status: run.status,
  mode: run.mode,
  passes: run.passes ?? 0,
  sources: (run.sources ?? []).map(source => ({
    name: source.name,
    ok: source.ok,
    durationMs: source.durationMs,
    ...(source.httpStatus === undefined ? {} : { httpStatus: source.httpStatus }),
    ...(source.recordCount === undefined ? {} : { recordCount: source.recordCount }),
    ...(source.error ? { error: source.error } : {}),
  })),
  joinCoverage: run.joinCoverage ?? [],
  changes: {
    added: run.changes?.added ?? [],
    promoted: run.changes?.promoted ?? [],
    deprecated: run.changes?.deprecated ?? [],
    repriced: run.changes?.repriced ?? [],
    flagged: run.changes?.flagged ?? [],
    operatorConflicts: run.changes?.operatorConflicts ?? [],
    plannedRows: run.changes?.plannedRows ?? 0,
    appendedRows: run.changes?.appendedRows ?? 0,
    plannedPriceRows: run.changes?.plannedPriceRows ?? 0,
    appendedPriceRows: run.changes?.appendedPriceRows ?? 0,
  },
  priceFlags: run.priceFlags ?? [],
  priceRows: run.priceRows ?? [],
  priceSkips: run.priceSkips ?? [],
  lifecycleTransitions: run.lifecycleTransitions ?? [],
  catalogDiff: run.catalogDiff ?? [],
  // Only the arrays the runner truncated carry a total; a missing one means the
  // stored array is complete.
  detailTotals: run.detailTotals ?? {},
  unmatchedIds: run.unmatchedIds ?? [],
  droppedRecords: run.droppedRecords ?? [],
});

const handler = baseApi()
  .get(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');

    const runId = req.query.runId;
    // ?runId=a&runId=b arrives as an array: answering the status list for it would
    // look like a successful report fetch to the caller.
    if (Array.isArray(runId)) throw new BadRequestError('runId must be a single value');
    if (typeof runId === 'string' && runId.length > 0) {
      const run = await modelDiscoveryRunRepository.runById(runId);
      if (!run) throw new NotFoundError('Discovery run not found');
      return res.json({ run: fullRun(run) });
    }

    const [runs, lastSuccessful, enabled, mode, autoEnable] = await Promise.all([
      modelDiscoveryRunRepository.recentRuns(RUN_LIST_LIMIT),
      modelDiscoveryRunRepository.lastSuccessfulRun(),
      adminSettingsRepository.getSettingsValue('enableModelDiscovery'),
      adminSettingsRepository.getSettingsValue('modelDiscoveryMode'),
      adminSettingsRepository.getSettingsValue('modelDiscoveryAutoEnable'),
    ]);
    // The newest run is the head of the list by construction, so the card and the
    // list can never disagree about what the last run was.
    const lastRun = runs[0] ?? null;

    return res.json({
      lastRun: lastRun ? trimRun(lastRun) : null,
      runs: runs.map(listRun),
      lastSuccessfulRunAt: lastSuccessful?.startedAt ?? null,
      // Same defaulting as the service's readMode: unset means on.
      enabled: enabled !== false,
      mode: mode ?? 'report',
      autoEnable: autoEnable ?? 'priced',
      selfHost: process.env.B4M_SELF_HOST === 'true',
    });
  })
  .post(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');

    // The service returns a 'skipped' result before it ever creates a run
    // document, so dispatching with the master switch off would answer 202 and
    // then never report anything. Refuse here instead.
    if ((await adminSettingsRepository.getSettingsValue('enableModelDiscovery')) === false) {
      return res.status(409).json({
        code: 'discovery-disabled',
        message: 'Model discovery is turned off (enableModelDiscovery); no run will start.',
      });
    }

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

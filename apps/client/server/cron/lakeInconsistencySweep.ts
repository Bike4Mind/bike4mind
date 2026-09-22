/**
 * Lake Inconsistency Sweep
 *
 * `detectLakeInconsistencies` was caller-triggered only: a lake's corpus problems surfaced when
 * somebody thought to POST /api/data-lakes/:id/inconsistencies, and nowhere else. This cron runs
 * the same pass over every ACTIVE lake on a schedule, so a contradiction that appears between one
 * curator's visits is found without anyone asking.
 *
 * DETECT, DO NOT REJECT (#2242). The pass reads chunk text and writes findings; it ingests nothing,
 * re-chunks nothing, removes nothing and gates nothing. A finding means "worth a human's eye".
 *
 * Findings are ROWS (`recordLakeFindings` -> `DataLakeFindingModel`), keyed on
 * (lakeId, detector, kind, subject), so a run re-detecting a known problem updates that row instead
 * of minting a second one - which is what makes a scheduled, repeating pass viable at all. What
 * lands on the lake document is only the run's own summary (`LakeInconsistencyScanSummary`): no
 * findings, therefore no document excerpts, therefore no retention obligation the purge-time
 * sweeps cannot reach.
 *
 * Scope: `status: 'active'` only, matching lakeHealthSweep - `deriveLakeServingState` gates
 * retrieval on exactly that status, so it is the one state where a corpus problem is reaching
 * anybody's answers.
 *
 * Cost/blast radius, and why the caps here are far tighter than the health sweep's: ONE lake's pass
 * reads up to INCONSISTENCY_MEMBER_SAMPLE (200) members x INCONSISTENCY_CHUNKS_PER_MEMBER (5)
 * documents out of the chunk collection - the scan #1665 measured as ruinous at connector scale and
 * the reason the caller-facing route is rate-limited per caller rather than per lake. So: a small
 * per-run lake cap, a per-lake concurrency of 2 rather than 5, and a try/catch per lake so one slow
 * or unreadable corpus costs only itself. The lake cap is joined by a WALL-CLOCK budget
 * (RUN_BUDGET_MS), because a cap on lakes cannot bound how long any one of them takes.
 *
 * A dated summary always stands over findings that were actually written. `recordLakeFindings`
 * isolates per-finding failures into a count rather than throwing, so ordering the two writes is
 * not on its own a guard - the summary write is GATED on a complete run. See `scanLake`.
 *
 * Fairness: the scan is STALENESS-ORDERED on `lastInconsistencyScanAt` (oldest first, never-scanned
 * first of all), and every lake the run ATTEMPTS is stamped whether its pass succeeded or failed.
 * A fleet larger than one run's cap therefore self-drains across runs with no persisted cursor, and
 * a lake that fails every time cannot hold the front of the queue forever. The page predicate lives
 * in `dataLakeRepository.findDueForInconsistencyScan`, shared with the health sweep, because
 * sorting on a field the run itself mutates needs two non-obvious arms - see that filter's comment.
 *
 * Schedule: daily at 4am UTC, deliberately BEFORE lakeHealthSweep (6am) - health renders the stored
 * inconsistency summary rather than computing it, so running after would have every daily health
 * snapshot report counts a day old. Enabled: production + dev, matching its sibling sweeps.
 */

import {
  connectDB,
  dataLakeRepository,
  dataLakeFindingRepository,
  fabFileRepository,
  fabFileChunkRepository,
} from '@bike4mind/database';
import { toScanSummary, type IDataLakeDocument } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { emitMetric } from '@server/utils/cloudwatch';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'lakeInconsistencySweep' } });

const CLOUDWATCH_NAMESPACE = 'Lumina5/DataLakes';

/** Per-page scan size, keyset-paginated so no page requires a `skip()`. */
const PAGE_SIZE = 25;

/**
 * Hard cap on lakes scanned in one run.
 *
 * Two orders of magnitude below lakeHealthSweep's 2000, and that gap is the point: a health grade
 * is a handful of bounded aggregations, while one detection pass reads up to 1000 chunk documents
 * of TEXT, so at this cap a run's worst case is ~200k of them. It is the count bound, not the time
 * bound - RUN_BUDGET_MS is what keeps a run inside the Lambda's timeout, because a cap on lakes
 * cannot bound how long any one of them takes. The staleness ordering is what makes a small cap
 * acceptable rather than lossy:
 * hitting it defers only the lakes this run just brought up to date, so a fleet bigger than the cap
 * is fully covered over ceil(activeCount / cap) runs.
 */
const MAX_LAKES_PER_RUN = 200;

/**
 * Concurrent per-lake passes. Two, not the health sweep's five: each pass already fans out 8-wide
 * internally over its own chunk reads (CHUNK_READ_CONCURRENCY), so the real concurrency against the
 * chunk collection is this number times that.
 */
const CONCURRENCY = 2;

/**
 * Wall-clock budget for the scan loop, checked between pages.
 *
 * MAX_LAKES_PER_RUN alone cannot bound the run: it caps how many lakes are attempted, not how long
 * one takes, and a fleet of large lakes (a membership aggregation, 25 sequential rounds of 8
 * parallel chunk reads, then up to 200 sequential upserts, all at CONCURRENCY 2) can spend minutes
 * per page. Without a deadline the Lambda is KILLED at its timeout - after the run metric is
 * emitted and before every other one, so a sweep that times out every night looks exactly like a
 * sweep that could not reach the database. Stopping early instead makes the shortfall a reported
 * `truncated`, and fairness carries the remainder to the next run for free.
 *
 * Eleven minutes against a 15-minute timeout: one page's worth of headroom to finish the page in
 * flight, plus the closing probe and metrics.
 */
const RUN_BUDGET_MS = 11 * 60 * 1000;

/** Exactly what `detectLakeInconsistencies` reads, plus the scan's own cursor field. */
const SCAN_FIELDS = {
  _id: 1,
  datalakeTag: 1,
  fileTagPrefix: 1,
  createdByUserId: 1,
  // Read back so the staleness-ordered scan can build the next page's keyset cursor from it.
  lastInconsistencyScanAt: 1,
} as const;

type SweepLake = Pick<
  IDataLakeDocument,
  'id' | 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId' | 'lastInconsistencyScanAt'
>;

interface ScanOutcome {
  /** False when findings went unwritten, so the lake's summary was deliberately left undated. */
  stored: boolean;
  findingsRecorded: number;
  findingsFailed: number;
}

async function scanLake(lake: SweepLake, nowYear: number, computedAt: Date): Promise<ScanOutcome> {
  const { report, suppressed } = await dataLakeService.detectLakeInconsistencies(lake, nowYear, {
    db: {
      fabFiles: fabFileRepository,
      fabFileChunks: fabFileChunkRepository,
      dataLakeFindings: dataLakeFindingRepository,
    },
    logger,
  });

  // Rows FIRST, summary second, and the ordering is the inverse of what the caller-facing route
  // used to do. The rows are the record now; the summary is the run's own footnote. So a summary
  // that is dated while its rows are missing would be the misleading half - `inconsistencyComputedAt`
  // is what a surface reads as "detection ran", and it must not outrun the findings it summarizes.
  //
  // Suppressed findings (#3045 - a curator dismissed them) are recorded alongside the reported ones
  // so the row behind a dismissal keeps tracking new evidence even though it stays out of the report.
  const { recorded, failed } = await dataLakeService.recordLakeFindings(
    lake.id,
    [...report.findings, ...suppressed],
    { detector: dataLakeService.INCONSISTENCY_DETECTOR, seenAt: computedAt },
    { db: { dataLakeFindings: dataLakeFindingRepository }, logger }
  );

  // A run that did not record every finding does not get to date a summary. `recordLakeFindings`
  // isolates per-finding failures into `failed` instead of throwing, so it never throws for an
  // unavailable collection - ordering the two writes is therefore not on its own enough, and
  // without this gate the sweep would stamp a fresh `inconsistencyComputedAt` and a full
  // `countsByKind` over rows that were never written. GET /inconsistencies selects its findings by
  // that very date, so the result would be counts claiming problems with no findings beside them.
  //
  // Leaving the last COMPLETE run's summary in place is the honest outcome, and costs nothing:
  // `recordDetected` is an idempotent upsert and the staleness stamp below rotates this lake back
  // into the queue, so the next run simply re-records and stores then.
  if (failed > 0) {
    return { stored: false, findingsRecorded: recorded, findingsFailed: failed };
  }

  await dataLakeRepository.update({
    id: lake.id,
    inconsistencyReport: toScanSummary(report),
    inconsistencyComputedAt: computedAt,
  });

  return { stored: true, findingsRecorded: recorded, findingsFailed: failed };
}

export async function handler() {
  const stage = Resource.App.stage;
  logger.info('[LakeInconsistencySweep] Starting sweep', { stage });

  // Ahead of the connect and the scan, so a sweep that cannot reach the database still reports as a
  // run rather than looking identical to one that was never scheduled.
  await emitMetric(CLOUDWATCH_NAMESPACE, 'LakeInconsistencySweepRuns', 1, { Stage: stage }, StandardUnit.Count);

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage));

  const computedAt = new Date();
  // One year for the whole run, read once: `detectLakeInconsistencies` takes it as a parameter
  // precisely so the same corpus yields the same report, and a run straddling New Year would
  // otherwise grade its first and last lakes against different definitions of "expired".
  const nowYear = computedAt.getUTCFullYear();

  const deadline = computedAt.getTime() + RUN_BUDGET_MS;

  let scanned = 0;
  let failed = 0;
  let findingsRecorded = 0;
  let findingsFailed = 0;
  // Keyset cursor on the sort key itself, not just `_id` - the scan order is staleness, not
  // insertion order, so the cursor has to be too. Null cursor = first page.
  let cursor: { lastInconsistencyScanAt: Date | null; id: string } | null = null;
  // Either bound can stop the loop - the lake cap or the wall-clock budget - and both mean the
  // same thing to the probe below: the scan ended before the fleet did.
  let stoppedShort = false;

  while (true) {
    // Checked between pages rather than between lakes: a page's fan-out is already bounded, and
    // abandoning one mid-flight would leave its in-progress lakes unstamped.
    if (scanned >= MAX_LAKES_PER_RUN || Date.now() >= deadline) {
      stoppedShort = true;
      break;
    }
    const pageLimit = Math.min(PAGE_SIZE, MAX_LAKES_PER_RUN - scanned);

    // Sequential pages: each page's cursor depends on the previous one, and paging exists to avoid
    // holding every active lake in memory at once.
    const lakes = (await dataLakeRepository.findDueForInconsistencyScan({
      cursor,
      limit: pageLimit,
      excludeScannedAt: computedAt,
      projection: SCAN_FIELDS,
    })) as unknown as SweepLake[];

    if (lakes.length === 0) break;
    const last = lakes[lakes.length - 1];
    cursor = { lastInconsistencyScanAt: last.lastInconsistencyScanAt ?? null, id: last.id };
    scanned += lakes.length;

    for (let i = 0; i < lakes.length; i += CONCURRENCY) {
      const batch = lakes.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async lake => {
          try {
            const outcome = await scanLake(lake, nowYear, computedAt);
            findingsRecorded += outcome.findingsRecorded;
            findingsFailed += outcome.findingsFailed;
            // A lake whose summary was withheld is a FAILED lake, not a quiet one. Without this the
            // only trace of a fleet-wide findings outage would be `findingsRecorded: 0`, which is
            // indistinguishable from a genuinely clean corpus.
            if (!outcome.stored) {
              failed += 1;
              logger.error('[LakeInconsistencySweep] Findings incompletely recorded; summary withheld', {
                lakeId: lake.id,
                findingsFailed: outcome.findingsFailed,
              });
            }
          } catch (err) {
            failed += 1;
            logger.error('[LakeInconsistencySweep] Detection pass failed for lake', { lakeId: lake.id, err });
          }
          // Stamped regardless of outcome, and OUTSIDE the try/catch above - a lake that keeps
          // failing must still sort to the back next run, or it (and whatever got capped behind it)
          // would starve forever. Its own failure is not allowed to crash the sweep.
          try {
            await dataLakeRepository.markInconsistencyScanned(lake.id, computedAt);
          } catch (err) {
            logger.error('[LakeInconsistencySweep] Failed to stamp lastInconsistencyScanAt for lake', {
              lakeId: lake.id,
              err,
            });
          }
        })
      );
    }

    // Keep paging until a page comes back short of what was asked for - a full page always implies
    // "there may be more", so this only stops on a genuinely final (or empty) page.
    if (lakes.length < pageLimit) break;
  }

  // `scanned >= cap` cannot tell "cap hit with lakes left over" from "the last lake WAS the 200th",
  // because at an exact multiple of the cap the final page is full too. One bounded, index-served
  // existence probe answers it rather than warning about a remainder that is not there.
  const truncated = stoppedShort && (await dataLakeRepository.hasMoreDueForInconsistencyScan(cursor, computedAt));

  if (truncated) {
    logger.warn('[LakeInconsistencySweep] Stopped short of the fleet; the staler remainder is picked up next run', {
      limit: MAX_LAKES_PER_RUN,
      budgetMs: RUN_BUDGET_MS,
      elapsedMs: Date.now() - computedAt.getTime(),
    });
  }
  if (findingsFailed > 0) {
    logger.warn('[LakeInconsistencySweep] Some findings were not persisted', { findingsFailed });
  }

  logger.info('[LakeInconsistencySweep] Sweep complete', {
    scanned,
    failed,
    findingsRecorded,
    findingsFailed,
    truncated,
  });
  await emitMetric(
    CLOUDWATCH_NAMESPACE,
    'LakeInconsistencySweepLakesScanned',
    scanned,
    { Stage: stage },
    StandardUnit.Count
  );
  await emitMetric(
    CLOUDWATCH_NAMESPACE,
    'LakeInconsistencySweepFailures',
    failed,
    { Stage: stage },
    StandardUnit.Count
  );
  await emitMetric(
    CLOUDWATCH_NAMESPACE,
    'LakeInconsistencySweepFindingsRecorded',
    findingsRecorded,
    { Stage: stage },
    StandardUnit.Count
  );
  // Emitted beside FindingsRecorded, not just logged: per-finding failures never reach the per-lake
  // `failed` counter on their own, so a sweep whose every write is failing would otherwise publish
  // `FindingsRecorded: 0, Failures: 0` - which reads as a clean run over a clean corpus, and is the
  // one shape no alarm could distinguish from success.
  await emitMetric(
    CLOUDWATCH_NAMESPACE,
    'LakeInconsistencySweepFindingsFailed',
    findingsFailed,
    { Stage: stage },
    StandardUnit.Count
  );

  return { status: 'OK', scanned, failed, findingsRecorded, findingsFailed, truncated };
}

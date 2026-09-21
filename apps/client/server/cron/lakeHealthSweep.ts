/**
 * Lake Health Sweep
 *
 * `computeLakeHealth` (the four retrievability predicates plus the reachable-content headline) is
 * otherwise only computed on demand, from GET /api/data-lakes/:id/health - so a lake degrading
 * quietly is invisible until someone opens it. This cron computes it for every ACTIVE lake on a
 * schedule and persists one row per lake per day (`DataLakeHealthSnapshotModel`), so the trend is
 * visible rather than just the current value. Report-only: nothing here alerts or acts on a bad
 * reading - that is deliberately future work once there is a baseline to alert against.
 *
 * Scope: `status: 'active'` only. `deriveLakeServingState` gates retrieval on exactly that status,
 * so it is the one state where a health regression is actionable; a draft is still being assembled
 * by its own owner (who can already open its health tab), and an archived/deleted lake serves
 * nothing, so grading either on a schedule would buy nothing but the cost this sweep exists to
 * bound.
 *
 * Cost/blast radius: keyset-paginated (PAGE_SIZE, no `skip()`), a hard per-run cap
 * (MAX_LAKES_PER_RUN - see the constant), and bounded fan-out (CONCURRENCY) for the per-lake
 * computation, mirroring dataLakeBatchReconcile's rescue sweeps. Each lake is wrapped in its own
 * try/catch so one slow or failing lake costs only itself, never the rest of the run.
 *
 * Fairness: the scan is STALENESS-ORDERED, not `_id`-ordered - oldest-`lastHealthCheckedAt`-first,
 * null (never checked) first of all - and every lake this run ATTEMPTS (success or failure) gets
 * `lastHealthCheckedAt` stamped to `computedAt`. So a fleet bigger than one run's cap does not
 * regrade the same prefix forever: whichever lakes were graded sort to the back next run, and the
 * previously-uncapped tail sorts to the front. No persisted cursor needed - the ordering itself
 * self-drains, and a run that dies mid-page loses nothing but that page's progress (see
 * `IDataLake.lastHealthCheckedAt`).
 *
 * Idempotency: `dataLakeHealthSnapshotRepository.upsertSnapshot` upserts on (lakeId, the UTC
 * calendar day), so a retried or re-run sweep overwrites that day's row instead of accumulating
 * duplicates or double-counting a trend point.
 *
 * Schedule: daily, after dataLakeBatchReconcile (5am UTC) so a batch that reconciler just forced
 * terminal is reflected the same day. Enabled: production + dev.
 */

import {
  connectDB,
  dataLakeRepository,
  fabFileRepository,
  adminSettingsRepository,
  scopedSettingsRepository,
  memoryLedgerRepository,
  dataLakeHealthSnapshotRepository,
} from '@bike4mind/database';
import type { IDataLakeDocument } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { emitMetric } from '@server/utils/cloudwatch';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'lakeHealthSweep' } });

const CLOUDWATCH_NAMESPACE = 'Lumina5/DataLakes';

/** Per-page scan size, keyset-paginated so no page requires a `skip()`. */
const PAGE_SIZE = 100;

/**
 * Hard cap on lakes graded in one run, so a runaway lake count cannot blow the Lambda timeout.
 *
 * Unlike dataLakeBatchReconcile's MAX_PER_RUN, a graded lake stays active - the candidate set is
 * not smaller next run just because this run touched it. What makes THIS cap self-drain instead is
 * the staleness ordering: hitting it only ever defers the lakes whose `lastHealthCheckedAt` is
 * newest, which is exactly the set this run just brought up to date, so they are the last lakes
 * due again. A fleet bigger than the cap gets fully covered over ceil(activeCount / cap) runs.
 */
const MAX_LAKES_PER_RUN = 2000;

/**
 * Bounded fan-out for the per-lake health computation. `computeLakeHealth` issues several of its
 * own DB reads per lake (member scan, membership scan, settings resolution), so unmetered
 * concurrency here is what turns "check every active lake" into a connection-pool incident -
 * mirrors dataLakeBatchReconcile's ENQUEUE_CONCURRENCY.
 */
const CONCURRENCY = 5;

/** The exact field set `computeLakeHealth` reads - see its own Pick<> signature. */
const SNAPSHOT_FIELDS = {
  _id: 1,
  status: 1,
  datalakeTag: 1,
  fileTagPrefix: 1,
  createdByUserId: 1,
  organizationId: 1,
  requiredPassageTokenTarget: 1,
  // Subpaths, never the whole report: `storedInconsistency` reads only these scalars and never
  // `findings`, and DataLakeRepository.find projects `inconsistencyReport` away by default
  // (LIST_PROJECTION_FIELDS) precisely so that array does not ride along on a fleet-wide scan.
  'inconsistencyReport.sampled': 1,
  'inconsistencyReport.memberSampled': 1,
  'inconsistencyReport.memberCount': 1,
  'inconsistencyReport.truncated': 1,
  'inconsistencyReport.countsByKind': 1,
  inconsistencyComputedAt: 1,
  lakeMemoryEnabled: 1,
  lakeMemoryExtractionAt: 1,
  lakeMemoryCursor: 1,
  lastSyncAt: 1,
  // Read back so the staleness-ordered scan can build the next page's keyset cursor from it.
  lastHealthCheckedAt: 1,
} as const;

type SweepLake = Pick<
  IDataLakeDocument,
  | 'id'
  | 'status'
  | 'datalakeTag'
  | 'fileTagPrefix'
  | 'createdByUserId'
  | 'organizationId'
  | 'requiredPassageTokenTarget'
  | 'inconsistencyReport'
  | 'inconsistencyComputedAt'
  | 'lakeMemoryEnabled'
  | 'lakeMemoryExtractionAt'
  | 'lakeMemoryCursor'
  | 'lastSyncAt'
  | 'lastHealthCheckedAt'
>;

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function computeAndPersist(lake: SweepLake, snapshotDate: string, computedAt: Date): Promise<void> {
  const health = await dataLakeService.computeLakeHealth(lake, {
    db: {
      fabFiles: fabFileRepository,
      adminSettings: adminSettingsRepository,
      scopedSettings: scopedSettingsRepository,
      memoryLedger: memoryLedgerRepository,
    },
    logger,
  });

  await dataLakeHealthSnapshotRepository.upsertSnapshot({
    lakeId: lake.id,
    organizationId: lake.organizationId ?? null,
    snapshotDate,
    computedAt,
    status: health.serving.status,
    servesRetrieval: health.serving.servesRetrieval,
    reachableShare: health.reachableShare,
    measuredMembers: health.coverage.measuredMembers,
    membersWithChunks: health.coverage.membersWithChunks,
    predicates: {
      chunkWithinPolicy: health.predicates.chunkWithinPolicy,
      chunkCountConsistent: health.predicates.chunkCountConsistent,
      fullyVectorized: health.predicates.fullyVectorized,
    },
    serveCapMeetsPolicy: health.predicates.serveCapMeetsPolicy === 'pass',
    affectedMemberCount: health.affectedMemberCount,
    scanTruncated: health.scanTruncated,
    duplicateMemberCount: health.duplicateMembers.memberCount,
    duplicateGroupCount: health.duplicateMembers.groupCount,
    lakeMemoryState: health.lakeMemory.state,
    inconsistencyFindingCount: health.inconsistency?.findingCount ?? null,
  });
}

export async function handler() {
  const stage = Resource.App.stage;
  logger.info('[LakeHealthSweep] Starting sweep', { stage });

  // Ahead of the connect and the scan, so a sweep that cannot reach the database still reports
  // as a run rather than looking identical to one that was never scheduled.
  await emitMetric(CLOUDWATCH_NAMESPACE, 'LakeHealthSweepRuns', 1, { Stage: stage }, StandardUnit.Count);

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage));

  const computedAt = new Date();
  const snapshotDate = utcDateString(computedAt);

  let scanned = 0;
  let failed = 0;
  // Keyset cursor on the sort key itself (lastHealthCheckedAt, _id), not just `_id` - the scan
  // order is staleness, not insertion order, so the cursor has to be too. Null cursor = first page.
  let cursor: { lastHealthCheckedAt: Date | null; id: string } | null = null;
  // Set only when a page came back FULL and the cap is what stopped the loop - `scanned >= cap`
  // alone cannot tell "cap hit with lakes left over" from "the last lake was the 2000th".
  let truncated = false;

  while (scanned < MAX_LAKES_PER_RUN) {
    const pageLimit = Math.min(PAGE_SIZE, MAX_LAKES_PER_RUN - scanned);
    const filter: Record<string, unknown> = { status: 'active' };
    if (cursor) {
      // Standard two-field keyset "greater than (a, b)": either the staleness key moved past the
      // cursor's, or it's tied and `_id` breaks the tie. `$gt: null` matches only documents with a
      // real (non-null) value - see BSON comparison order - which is exactly "past every
      // never-checked lake" when the cursor itself was one of them.
      filter.$or = [
        { lastHealthCheckedAt: { $gt: cursor.lastHealthCheckedAt } },
        { lastHealthCheckedAt: cursor.lastHealthCheckedAt, _id: { $gt: cursor.id } },
      ];
    }

    // Sequential pages are the point: each page's cursor depends on the previous one, and paging
    // exists to avoid holding every active lake in memory at once.
    const lakes = (await dataLakeRepository.find(filter, {
      sort: { lastHealthCheckedAt: 1, _id: 1 },
      limit: pageLimit,
      ...SNAPSHOT_FIELDS,
    })) as unknown as SweepLake[];

    if (lakes.length === 0) break;
    const last = lakes[lakes.length - 1];
    cursor = { lastHealthCheckedAt: last.lastHealthCheckedAt ?? null, id: last.id };
    scanned += lakes.length;

    for (let i = 0; i < lakes.length; i += CONCURRENCY) {
      const batch = lakes.slice(i, i + CONCURRENCY);
      // CONCURRENCY-wide batches, not one lake at a time - see the constant's doc comment for why
      // fan-out is bounded rather than unlimited.
      await Promise.all(
        batch.map(async lake => {
          try {
            await computeAndPersist(lake, snapshotDate, computedAt);
          } catch (err) {
            failed += 1;
            logger.error('[LakeHealthSweep] Failed to compute/persist health for lake', { lakeId: lake.id, err });
          }
          // Stamped regardless of outcome, and OUTSIDE the try/catch above - a lake that keeps
          // failing must still sort to the back next run, or it (and whatever else got capped
          // behind it) would starve forever. Its own failure is not allowed to crash the sweep.
          try {
            await dataLakeRepository.markHealthChecked(lake.id, computedAt);
          } catch (err) {
            logger.error('[LakeHealthSweep] Failed to stamp lastHealthCheckedAt for lake', { lakeId: lake.id, err });
          }
        })
      );
    }

    // Keep paging until a page comes back short of what was asked for - a full page always
    // implies "there may be more", so this only stops on a genuinely final (or empty) page.
    if (lakes.length < pageLimit) break;
    truncated = scanned >= MAX_LAKES_PER_RUN;
  }

  if (truncated) {
    logger.warn('[LakeHealthSweep] Hit the per-run lake cap; the staler remainder is picked up next run', {
      limit: MAX_LAKES_PER_RUN,
    });
  }

  logger.info('[LakeHealthSweep] Sweep complete', { scanned, failed, truncated });
  await emitMetric(CLOUDWATCH_NAMESPACE, 'LakeHealthSweepLakesScanned', scanned, { Stage: stage }, StandardUnit.Count);
  await emitMetric(CLOUDWATCH_NAMESPACE, 'LakeHealthSweepFailures', failed, { Stage: stage }, StandardUnit.Count);

  return { status: 'OK', scanned, failed, truncated };
}

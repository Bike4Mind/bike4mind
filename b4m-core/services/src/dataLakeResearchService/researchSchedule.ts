import type {
  IDataLakeProposalRepository,
  IDataLakeResearchConfigDocument,
  IDataLakeResearchConfigRepository,
  IDataLakeResearchRunDocument,
  ResearchScheduleCadence,
  ResearchScheduleOutcome,
} from '@bike4mind/common';
import { RESEARCH_REVIEW_BACKLOG_LIMIT_DEFAULT, RESEARCH_REVIEW_BACKLOG_LIMIT_MAX } from '@bike4mind/common';
import { ResearchRunRefusedError, startResearchRun, type StartResearchRunAdapters } from './startResearchRun';

/**
 * Scheduled research runs: which configs are due, whether each one may start, and when it is next
 * due. Driven by the hosted `dataLakeResearchSchedule` cron and the self-host worker's twin, which
 * both call `runDueResearchSchedules` once per tick.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a claimed config is held before another tick may claim it again. Covers the whole
 * per-config decision (count, start, enqueue, record), which is seconds; the margin only matters
 * when the outcome write itself fails, and then the config is retried after the lease.
 */
export const RESEARCH_SCHEDULE_LEASE_MS = 15 * 60 * 1000;

/** Configs one tick fires at most. The rest are still due next tick. */
export const RESEARCH_SCHEDULE_BATCH_MAX = 50;

/**
 * When a due run could not start for a reason that clears on its own (another run in flight, the
 * daily cap, a transient fault), try again after this rather than waiting a whole cadence period.
 */
export const RESEARCH_SCHEDULE_RETRY_MS = 60 * 60 * 1000;

const SCHEDULED_START_FAILED_MESSAGE = 'The scheduled run could not be started. It will be retried in about an hour.';

const addUtcMonth = (from: Date): Date => {
  const next = new Date(from);
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  // Clamp to the target month's last day: Jan 31 + 1 month is Feb 28/29, not Mar 3.
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
};

export function addCadence(cadence: Exclude<ResearchScheduleCadence, 'off'>, from: Date): Date {
  switch (cadence) {
    case 'daily':
      return new Date(from.getTime() + DAY_MS);
    case 'weekly':
      return new Date(from.getTime() + 7 * DAY_MS);
    case 'monthly':
      return addUtcMonth(from);
  }
}

/** First due time for a config whose cadence was just set, or null when scheduling is off. */
export function firstResearchRunAt(cadence: ResearchScheduleCadence, now: Date): Date | null {
  return cadence === 'off' ? null : addCadence(cadence, now);
}

/**
 * The next slot after `now`, stepping from the slot that came due. Anchored on the due slot rather
 * than on `now` so a daily run does not creep later by one tick's lag every day, and stepped past
 * `now` so a scheduler outage does not come back to a burst of catch-up runs.
 */
export function nextResearchRunAfter(cadence: Exclude<ResearchScheduleCadence, 'off'>, dueAt: Date, now: Date): Date {
  let next = addCadence(cadence, dueAt);
  while (next.getTime() <= now.getTime()) next = addCadence(cadence, next);
  return next;
}

export function normalizeReviewBacklogLimit(value: unknown): number {
  const parsed =
    typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : RESEARCH_REVIEW_BACKLOG_LIMIT_DEFAULT;
  return Math.min(Math.max(parsed, 1), RESEARCH_REVIEW_BACKLOG_LIMIT_MAX);
}

export interface ResearchScheduleAdapters {
  db: {
    dataLakeResearchConfigs: Pick<IDataLakeResearchConfigRepository, 'claimDueConfigs' | 'recordScheduleOutcome'> &
      StartResearchRunAdapters['db']['dataLakeResearchConfigs'];
    dataLakeResearchRuns: StartResearchRunAdapters['db']['dataLakeResearchRuns'];
    dataLakeProposals: Pick<IDataLakeProposalRepository, 'countPendingByLakes'>;
  };
  /**
   * Hands a started run to its executor. On failure it must settle the run itself (a run left
   * `queued` holds the lake's one-at-a-time guard shut) and then throw.
   */
  enqueue: (run: IDataLakeResearchRunDocument) => Promise<void>;
  logger: {
    info: (message: string) => void;
    error: (message: string, error?: Error) => void;
  };
  now?: () => Date;
}

export interface ResearchScheduleTickSummary {
  claimed: number;
  started: number;
  skipped: number;
  failed: number;
}

type ScheduledConfig = IDataLakeResearchConfigDocument & { cadence: Exclude<ResearchScheduleCadence, 'off'> };

async function fireScheduledConfig(
  config: ScheduledConfig,
  at: Date,
  { db, enqueue }: ResearchScheduleAdapters
): Promise<ResearchScheduleOutcome> {
  // Checked before startResearchRun so a skipped tick writes no run row and spends nothing.
  const pendingByLake = await db.dataLakeProposals.countPendingByLakes([config.dataLakeId]);
  const pendingProposals = pendingByLake[config.dataLakeId] ?? 0;
  const reviewBacklogLimit = normalizeReviewBacklogLimit(config.reviewBacklogLimit);
  if (pendingProposals >= reviewBacklogLimit) {
    return { outcome: 'skipped', at, reason: 'review_backlog', pendingProposals, reviewBacklogLimit };
  }

  let run: IDataLakeResearchRunDocument;
  try {
    run = await startResearchRun(config.id, config.dataLakeId, { trigger: 'periodic' }, { db, now: () => at });
  } catch (error) {
    if (error instanceof ResearchRunRefusedError) return { outcome: 'skipped', at, reason: error.reason };
    throw error;
  }

  await enqueue(run);
  return { outcome: 'started', at, runId: run.id };
}

/** The next due time for an outcome. Only a started run or a full queue waits a whole period. */
function nextRunAtFor(config: ScheduledConfig, outcome: ResearchScheduleOutcome, at: Date): Date {
  const waitsFullPeriod =
    outcome.outcome === 'started' || (outcome.outcome === 'skipped' && outcome.reason === 'review_backlog');
  if (!waitsFullPeriod) return new Date(at.getTime() + RESEARCH_SCHEDULE_RETRY_MS);
  return nextResearchRunAfter(config.cadence, config.nextRunAt ?? at, at);
}

export async function runDueResearchSchedules(
  adapters: ResearchScheduleAdapters
): Promise<ResearchScheduleTickSummary> {
  const { db, logger, now = () => new Date() } = adapters;
  const at = now();
  const claimed = await db.dataLakeResearchConfigs.claimDueConfigs(
    at,
    new Date(at.getTime() + RESEARCH_SCHEDULE_LEASE_MS),
    RESEARCH_SCHEDULE_BATCH_MAX
  );

  const summary: ResearchScheduleTickSummary = { claimed: claimed.length, started: 0, skipped: 0, failed: 0 };

  for (const claimedConfig of claimed) {
    // claimDueConfigs filters on cadence != 'off'; the guard narrows the type and covers a legacy row.
    if (!claimedConfig.cadence || claimedConfig.cadence === 'off') continue;
    const config = claimedConfig as ScheduledConfig;

    // Isolated per config: one lake's fault must not stop every lake behind it in the batch.
    let outcome: ResearchScheduleOutcome;
    try {
      outcome = await fireScheduledConfig(config, at, adapters);
    } catch (error) {
      // The detail goes to the log; the card gets a sentence a lake manager can act on.
      logger.error(`[research-schedule] config ${config.id} failed to start`, error as Error);
      outcome = { outcome: 'failed', at, error: SCHEDULED_START_FAILED_MESSAGE };
    }
    summary[outcome.outcome] += 1;

    try {
      await db.dataLakeResearchConfigs.recordScheduleOutcome(
        config.id,
        config.cadence,
        outcome,
        nextRunAtFor(config, outcome, at)
      );
    } catch (error) {
      // The lease still holds the config, so the worst case is a retry once it expires.
      logger.error(`[research-schedule] could not record the outcome for config ${config.id}`, error as Error);
    }
  }

  logger.info(
    `[research-schedule] claimed ${summary.claimed}, started ${summary.started}, skipped ${summary.skipped}, failed ${summary.failed}`
  );
  return summary;
}

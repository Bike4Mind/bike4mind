/**
 * Starts the scheduled briefs that have come due. Each due user is claimed by moving `nextBriefAt` to its
 * next slot with a compare-and-set, so overlapping runs (at-least-once delivery, or the self-host twin
 * next to a hosted run) start a slot once. The next slot is computed from now, not from the missed one,
 * so an outage yields one brief rather than a backlog. Retry-safe failures hand the slot back for up to
 * RETRY_WINDOW_MS after it fell due; uncertain event acceptance retains the row and advanced slot.
 * The brief itself rides the existing `brief.compose`
 * event; startScheduledBrief skips users whose schedule was turned off after the claim, users with brief
 * pushes off, windows with no agent runs and no pending triaged email, and starts within
 * SCHEDULED_BRIEF_MIN_GAP_MS of another brief start (`debounced`: a racing event brief covers the slot,
 * which stays advanced). The next slot is the earlier of the schedule's next slot and the next approved
 * reminder, and accepted, debounced or in-flight work with an unlisted due reminder is retried once the gap has passed,
 * so a reminder the racing brief did not list never waits for the following regular slot.
 *
 * A second pass starts one brief per ended calendar busy block (startBlockBrief). The claim is the same
 * compare-and-set shape on `nextBlockBriefAt`, which also records the block end in `lastBlockBriefEnd` so a
 * later sync cannot re-arm a block already briefed. Blocks that ended more than RETRY_WINDOW_MS ago (an
 * outage) are claimed and dropped.
 *
 * Schedule: rate(5 minutes). Self-host twin: apps/workers/src/selfhost/briefScheduleReconcile.ts.
 */
import type { Context } from 'aws-lambda';
import { BUSY_BLOCK_LIMITS } from '@bike4mind/common';
import { assistantBriefRepository, connectDB, userRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { computeNextBriefAt, SCHEDULED_BRIEF_MIN_GAP_MS } from '@bike4mind/server-utils/briefs/briefSchedule';
import {
  BriefComposeStartError,
  startBlockBrief,
  startScheduledBrief,
  type BlockBriefOutcome,
  type ScheduledBriefOutcome,
} from '@bike4mind/server-utils/briefs/startBriefComposition';
import { notifyHeldBlockRuns } from '@bike4mind/server-utils/briefs/notifyHeldBlockRuns';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'briefScheduleReconcile' } });

// Per-run cap; a backlog drains over successive runs, earliest first.
export const BRIEF_SCHEDULE_BATCH_LIMIT = 100;
// Headroom left on the Lambda clock when the run stops claiming new users (ms).
const STOP_BEFORE_TIMEOUT_MS = 30_000;
// How long after its due time a slot whose start failed is still retried by later runs (ms). Shared with
// the busy-block normalizer, which drops blocks that ended before it.
export const RETRY_WINDOW_MS = BUSY_BLOCK_LIMITS.retryWindowMs;

export type BriefScheduleReconcileDeps = {
  users: Pick<
    typeof userRepository,
    | 'findDueBriefSchedules'
    | 'advanceNextBriefAt'
    | 'pullNextBriefAtForward'
    | 'findDueBlockBriefs'
    | 'advanceNextBlockBriefAt'
    | 'releaseBlockBriefClaim'
  >;
  reminders: Pick<typeof assistantBriefRepository, 'findEarliestPendingReminderAt' | 'findDueReminders'>;
  startScheduledBrief: (userId: string) => Promise<ScheduledBriefOutcome>;
  startBlockBrief: (userId: string, block: { start: Date; end: Date }) => Promise<BlockBriefOutcome>;
  /** Summary push for a block dropped as stale; defaults to notifyHeldBlockRuns. */
  notifyHeldBlockRuns?: (userId: string, block: { start: Date; end: Date }) => Promise<void>;
  /** True once the run should stop claiming users. */
  outOfTime: () => boolean;
};

export type BriefScheduleReconcileResult = Record<ScheduledBriefOutcome, number> & {
  due: number;
  claimedElsewhere: number;
  unscheduled: number;
  failed: number;
  blocks: BlockBriefReconcileResult;
};

export type BlockBriefReconcileResult = Record<BlockBriefOutcome, number> & {
  due: number;
  claimedElsewhere: number;
  /** The due end matched no stored block (re-synced away); the due time still moves on. */
  unscheduled: number;
  stale: number;
  failed: number;
};

async function withNextReminder(
  deps: BriefScheduleReconcileDeps,
  userId: string,
  now: Date,
  next: Date
): Promise<Date> {
  try {
    const reminderAt = await deps.reminders.findEarliestPendingReminderAt(userId, now);
    return reminderAt && reminderAt < next ? reminderAt : next;
  } catch (err) {
    logger.warn('[briefScheduleReconcile] reading the next reminder failed; keeping the regular slot', { userId, err });
    return next;
  }
}

async function reconcileReminderWakeUp(
  deps: BriefScheduleReconcileDeps,
  userId: string,
  now: Date,
  outcome: ScheduledBriefOutcome
): Promise<void> {
  const retryOverdue = outcome === 'enqueued' || outcome === 'debounced' || outcome === 'in_flight';
  if (!retryOverdue && outcome !== 'no_activity') return;
  try {
    // Accepted work may list only part of the backlog. Keep a bounded retry until it is surfaced.
    const reminderAt = await deps.reminders.findEarliestPendingReminderAt(userId, retryOverdue ? undefined : now);
    if (!reminderAt) return;
    const wakeAt = reminderAt <= now ? new Date(now.getTime() + SCHEDULED_BRIEF_MIN_GAP_MS) : reminderAt;
    await deps.users.pullNextBriefAtForward(userId, wakeAt);
  } catch (err) {
    // Never release an accepted composition because its post-claim reminder lookup failed.
    logger.warn('[briefScheduleReconcile] failed to reconcile a reminder wake-up', { userId, err });
    if (retryOverdue) {
      try {
        await deps.users.pullNextBriefAtForward(userId, new Date(now.getTime() + SCHEDULED_BRIEF_MIN_GAP_MS));
      } catch (retryError) {
        logger.warn('[briefScheduleReconcile] failed to retain a reminder retry', { userId, err: retryError });
      }
    }
  }
}

export async function runBriefScheduleReconcile(
  deps: BriefScheduleReconcileDeps,
  now: Date = new Date()
): Promise<BriefScheduleReconcileResult> {
  const due = await deps.users.findDueBriefSchedules(now, BRIEF_SCHEDULE_BATCH_LIMIT);
  const result: BriefScheduleReconcileResult = {
    due: due.length,
    claimedElsewhere: 0,
    unscheduled: 0,
    failed: 0,
    debounced: 0,
    enqueued: 0,
    in_flight: 0,
    no_activity: 0,
    push_off: 0,
    schedule_off: 0,
    user_missing: 0,
    blocks: {
      due: 0,
      claimedElsewhere: 0,
      unscheduled: 0,
      stale: 0,
      failed: 0,
      busy_off: 0,
      enqueued: 0,
      in_flight: 0,
      no_activity: 0,
      push_off: 0,
      user_missing: 0,
    },
  };

  for (const user of due) {
    if (deps.outOfTime()) break;
    let next: Date | null = null;
    let invalidSchedule = false;
    try {
      next = user.schedule ? computeNextBriefAt(user.schedule, now) : null;
      if (next && user.schedule?.enabled) next = await withNextReminder(deps, user.id, now, next);
    } catch (err) {
      // A stored schedule that cannot be computed (an unknown zone) is cleared rather than left at the
      // head of the earliest-first batch, where it would fail every run.
      invalidSchedule = true;
      logger.error('[briefScheduleReconcile] stored brief schedule is invalid; clearing its due time', {
        userId: user.id,
        err,
      });
    }

    let claimed = false;
    try {
      claimed = await deps.users.advanceNextBriefAt(user.id, user.nextBriefAt, next);
    } catch (err) {
      result.failed++;
      logger.error('[briefScheduleReconcile] failed to claim a scheduled brief', { userId: user.id, err });
      continue;
    }
    if (!claimed) {
      result.claimedElsewhere++;
      continue;
    }
    if (invalidSchedule) {
      result.failed++;
      continue;
    }
    // A schedule turned off (or missing) only clears its stale due time.
    if (!user.schedule?.enabled) {
      result.unscheduled++;
      continue;
    }

    try {
      const outcome = await deps.startScheduledBrief(user.id);
      result[outcome]++;
      await reconcileReminderWakeUp(deps, user.id, now, outcome);
    } catch (err) {
      result.failed++;
      // Only release submission failures when non-delivery and cleanup are established.
      const retry =
        !(err instanceof BriefComposeStartError && !err.retrySafe) &&
        next !== null &&
        now.getTime() - user.nextBriefAt.getTime() < RETRY_WINDOW_MS;
      logger.error('[briefScheduleReconcile] failed to start a scheduled brief', { userId: user.id, retry, err });
      if (retry && next) {
        await deps.users.advanceNextBriefAt(user.id, next, user.nextBriefAt).catch((releaseErr: unknown) => {
          logger.error('[briefScheduleReconcile] failed to release a claimed slot for retry', {
            userId: user.id,
            err: releaseErr,
          });
        });
      }
    }
  }

  const dueBlocks = deps.outOfTime() ? [] : await reconcileBlockBriefs(deps, now, result.blocks);

  logger.info('[briefScheduleReconcile] run complete', {
    ...result,
    capped: due.length === BRIEF_SCHEDULE_BATCH_LIMIT,
    blocksCapped: dueBlocks === BRIEF_SCHEDULE_BATCH_LIMIT,
  });
  return result;
}

/** Starts one brief per ended busy block; returns how many due users were read. */
async function reconcileBlockBriefs(
  deps: BriefScheduleReconcileDeps,
  now: Date,
  result: BlockBriefReconcileResult
): Promise<number> {
  const due = await deps.users.findDueBlockBriefs(now, BRIEF_SCHEDULE_BATCH_LIMIT);
  result.due = due.length;

  for (const user of due) {
    if (deps.outOfTime()) break;
    const ended = user.nextBlockBriefAt;
    const block = user.blocks.find(b => b.end.getTime() === ended.getTime());
    const nextEnd = user.blocks
      .map(b => b.end)
      .filter(end => end.getTime() > ended.getTime())
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const expected = { nextBlockBriefAt: ended, lastBlockBriefEnd: user.lastBlockBriefEnd };
    const claimedPair = { nextBlockBriefAt: nextEnd ?? null, lastBlockBriefEnd: ended };

    let claimed = false;
    try {
      claimed = await deps.users.advanceNextBlockBriefAt(user.id, expected, claimedPair);
    } catch (err) {
      result.failed++;
      logger.error('[briefScheduleReconcile] failed to claim a block brief', { userId: user.id, err });
      continue;
    }
    if (!claimed) {
      result.claimedElsewhere++;
      continue;
    }
    if (!block) {
      result.unscheduled++;
      continue;
    }
    const withinRetryWindow = now.getTime() - ended.getTime() < RETRY_WINDOW_MS;
    if (!withinRetryWindow) {
      result.stale++;
      await (deps.notifyHeldBlockRuns ?? notifyHeldBlockRuns)(user.id, block);
      continue;
    }

    const release = async () => {
      try {
        const released = await deps.users.releaseBlockBriefClaim(user.id, block, user.lastBlockBriefEnd);
        if (!released) logger.warn('[briefScheduleReconcile] claimed block not handed back', { userId: user.id });
      } catch (releaseErr) {
        logger.error('[briefScheduleReconcile] failed to release a claimed block for retry', {
          userId: user.id,
          err: releaseErr,
        });
      }
    };

    let outcome: BlockBriefOutcome;
    try {
      outcome = await deps.startBlockBrief(user.id, block);
    } catch (err) {
      result.failed++;
      const retry = !(err instanceof BriefComposeStartError && !err.retrySafe);
      logger.error('[briefScheduleReconcile] failed to start a block brief', { userId: user.id, retry, err });
      if (retry) await release();
      continue;
    }
    result[outcome]++;
    // Another brief is composing; hand the block back so a later run starts it once that one settles.
    if (outcome === 'in_flight') await release();
  }
  return due.length;
}

export async function handler(_event: unknown, context?: Pick<Context, 'getRemainingTimeInMillis'>) {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  const result = await runBriefScheduleReconcile({
    users: userRepository,
    reminders: assistantBriefRepository,
    startScheduledBrief: userId => startScheduledBrief(userId),
    startBlockBrief: (userId, block) => startBlockBrief(userId, block),
    outOfTime: () => (context ? context.getRemainingTimeInMillis() < STOP_BEFORE_TIMEOUT_MS : false),
  });
  // Surface failed starts in the LambdaErrors alarm, including retained uncertain submissions.
  const failed = result.failed + result.blocks.failed;
  if (failed > 0) throw new Error(`Failed to start ${failed} scheduled or block brief(s)`);
  return result;
}

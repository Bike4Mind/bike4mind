/**
 * Starts the scheduled briefs that have come due. Each due user is claimed by moving `nextBriefAt` to its
 * next slot with a compare-and-set, so overlapping runs (at-least-once delivery, or the self-host twin
 * next to a hosted run) start a slot once. The next slot is computed from now, not from the missed one,
 * so an outage yields one brief rather than a backlog. Retry-safe failures hand the slot back for up to
 * RETRY_WINDOW_MS after it fell due; uncertain event acceptance retains the row and advanced slot.
 * The brief itself rides the existing `brief.compose`
 * event; startScheduledBrief skips users whose schedule was turned off after the claim, users with brief
 * pushes off, windows with no agent runs, and starts within SCHEDULED_BRIEF_MIN_GAP_MS of another brief
 * start (`debounced`: a racing event brief covers the slot, which stays advanced).
 *
 * Schedule: rate(5 minutes). Self-host twin: apps/workers/src/selfhost/briefScheduleReconcile.ts.
 */
import type { Context } from 'aws-lambda';
import { connectDB, userRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { computeNextBriefAt } from '@bike4mind/server-utils/briefs/briefSchedule';
import {
  BriefComposeStartError,
  startScheduledBrief,
  type ScheduledBriefOutcome,
} from '@bike4mind/server-utils/briefs/startBriefComposition';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'briefScheduleReconcile' } });

// Per-run cap; a backlog drains over successive runs, earliest first.
export const BRIEF_SCHEDULE_BATCH_LIMIT = 100;
// Headroom left on the Lambda clock when the run stops claiming new users (ms).
const STOP_BEFORE_TIMEOUT_MS = 30_000;
// How long after its due time a slot whose start failed is still retried by later runs (ms).
export const RETRY_WINDOW_MS = 60 * 60 * 1000;

export type BriefScheduleReconcileDeps = {
  users: Pick<typeof userRepository, 'findDueBriefSchedules' | 'advanceNextBriefAt'>;
  startScheduledBrief: (userId: string) => Promise<ScheduledBriefOutcome>;
  /** True once the run should stop claiming users. */
  outOfTime: () => boolean;
};

export type BriefScheduleReconcileResult = Record<ScheduledBriefOutcome, number> & {
  due: number;
  claimedElsewhere: number;
  unscheduled: number;
  failed: number;
};

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
  };

  for (const user of due) {
    if (deps.outOfTime()) break;
    let next: Date | null = null;
    let invalidSchedule = false;
    try {
      next = user.schedule ? computeNextBriefAt(user.schedule, now) : null;
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
      result[await deps.startScheduledBrief(user.id)]++;
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

  logger.info('[briefScheduleReconcile] run complete', {
    ...result,
    capped: due.length === BRIEF_SCHEDULE_BATCH_LIMIT,
  });
  return result;
}

export async function handler(_event: unknown, context?: Pick<Context, 'getRemainingTimeInMillis'>) {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  const result = await runBriefScheduleReconcile({
    users: userRepository,
    startScheduledBrief: userId => startScheduledBrief(userId),
    outOfTime: () => (context ? context.getRemainingTimeInMillis() < STOP_BEFORE_TIMEOUT_MS : false),
  });
  // Surface failed starts in the LambdaErrors alarm, including retained uncertain submissions.
  if (result.failed > 0) throw new Error(`Failed to start ${result.failed} scheduled brief(s)`);
  return result;
}

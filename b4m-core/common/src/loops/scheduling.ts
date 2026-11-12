import { activeLaneCount, type ILoop } from '../types/entities/LoopTypes';

/** Ceiling on the idle back-off, as a multiple of the loop's interval (and never past a day). */
export const MAX_BACKOFF_FACTOR = 8;

/** A live loop past due by this many intervals (and at least the floor, in minutes) with ready tickets is flagged. */
export const LOOP_IDLE_ALARM_INTERVALS = 3;

export const LOOP_IDLE_ALARM_FLOOR_MIN = 30;

/** A cloud run older than the floor and this many times the loop's median run (last few completed) is flagged. */
export const LOOP_LONG_RUN_FLOOR_MS = 60 * 60 * 1000;

export const LOOP_LONG_RUN_FACTOR = 3;

export const LOOP_LONG_RUN_MIN_SAMPLES = 3;

const MINUTE_MS = 60 * 1000;

export const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Run age past which a run is flagged as long: the floor alone until the loop has a few completed runs. */
export const longRunThresholdMs = (durationsMs: number[]): number =>
  durationsMs.length < LOOP_LONG_RUN_MIN_SAMPLES
    ? LOOP_LONG_RUN_FLOOR_MS
    : Math.max(LOOP_LONG_RUN_FLOOR_MS, LOOP_LONG_RUN_FACTOR * median(durationsMs));

/** A `tickets` wake-mode loop ignores its interval, so only the floor applies, counted from when a ticket made it due. */
export const idleAlarmThresholdMin = (intervalMinutes: number, wakeMode?: ILoop['wakeMode']): number =>
  wakeMode === 'tickets'
    ? LOOP_IDLE_ALARM_FLOOR_MIN
    : Math.max(LOOP_IDLE_ALARM_INTERVALS * intervalMinutes, LOOP_IDLE_ALARM_FLOOR_MIN);

/**
 * The idle-with-work rule minus the ready-ticket lookup: a live loop with no run in flight and no claim, held
 * back by nothing deliberate (no pacing or capacity hold, no idle back-off), and far past its due time.
 * Paused, needs_you and error loops never match, nor does one with no `nextRunAt` (a `tickets` wake-mode loop no
 * ticket has made due).
 */
export function idleAlarmCandidate(
  loop: Pick<
    ILoop,
    | 'status'
    | 'activeExecutionIds'
    | 'leaseUntil'
    | 'hold'
    | 'idleStreak'
    | 'nextRunAt'
    | 'intervalMinutes'
    | 'wakeMode'
  >,
  now: Date
): boolean {
  // Any lane running is progress; a free lane beside it with ready tickets is due and claimable, not idle.
  if (loop.status !== 'live' || activeLaneCount(loop) > 0 || !loop.nextRunAt) return false;
  if (loop.leaseUntil && new Date(loop.leaseUntil) > now) return false;
  // A capacity hold is rewritten every tick. A live pacing hold sets nextRunAt to its `until`, so the past-due
  // check below excludes it; one left behind after an owner reschedule must not hide an idle loop.
  if (loop.hold?.kind === 'capacity') return false;
  if (loop.idleStreak) return false;
  return (
    new Date(loop.nextRunAt).getTime() <=
    now.getTime() - idleAlarmThresholdMin(loop.intervalMinutes, loop.wakeMode) * MINUTE_MS
  );
}

/** Minutes until the next run after `idleStreak` idle runs in a row: doubling, capped at 8x and at a day. */
export function backoffMinutes(intervalMinutes: number, idleStreak: number): number {
  return Math.max(
    intervalMinutes,
    Math.min(intervalMinutes * 2 ** idleStreak, MAX_BACKOFF_FACTOR * intervalMinutes, 24 * 60)
  );
}

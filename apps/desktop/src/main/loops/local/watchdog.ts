/**
 * The local loop watchdog's decisions, kept free of the scheduler and electron so they test alone.
 * LocalLoopScheduler.watchdog applies them every WATCHDOG_MS.interval from main (loops/local/index.ts); no LLM call.
 */
export const WATCHDOG_MS = {
  interval: 60_000,
  /** A tick still running after this is hung. */
  tickHung: 5 * 60_000,
  /** No tick for this long while a loop is live: the timer was lost (the scheduler re-checks every minute). */
  noTick: 3 * 60_000,
  /** A run with no stream event for this long gets one alarm event... */
  runAlarm: 15 * 60_000,
  /** ...and for this long is aborted, counted, so a ticket that always hangs reaches its run limit. */
  runAbort: 45 * 60_000,
  /** A lane none of whose sessions is busy, silent this long, lost its session. */
  deadLane: 2 * 60_000,
  /** A lane still opening its session after this never will. */
  opening: 5 * 60_000,
  /** A live loop with ready work and no lane for this long gets one alarm per idle stretch. */
  idleWithWork: 30 * 60_000,
} as const;

/** Scheduler restarts allowed per rolling hour; then every live loop goes to `error`. */
export const RESTART_LIMIT = 5;
const HOUR = 60 * 60_000;

/** The restart budget: RESTART_LIMIT an hour, each after a doubling gap (1, 2, 4, 8 min) from the last. */
export class RestartBudget {
  private restarts: number[] = [];

  /** Count of restarts in the last hour, for the event text. */
  get used(): number {
    return this.restarts.length;
  }

  next(now: number): 'restart' | 'wait' | 'give_up' {
    this.restarts = this.restarts.filter(at => now - at < HOUR);
    const count = this.restarts.length;
    if (count >= RESTART_LIMIT) return 'give_up';
    const last = this.restarts.at(-1);
    if (last !== undefined && now < last + 2 ** (count - 1) * 60_000) return 'wait';
    this.restarts.push(now);
    return 'restart';
  }
}

export function schedulerStalled(
  state: { liveLoops: number; ticking: boolean; tickStartedAt: number; lastTickAt: number },
  now: number
): boolean {
  if (state.ticking) return now - state.tickStartedAt > WATCHDOG_MS.tickHung;
  return state.liveLoops > 0 && now - state.lastTickAt > WATCHDOG_MS.noTick;
}

export interface LaneState {
  runId: string;
  /** Still opening its session. */
  opening: boolean;
  /** Any of the run's sessions is working. */
  busy: boolean;
  startedAt: number;
  lastEventAt: number;
  alarmed: boolean;
}

export function laneChecks(
  lanes: readonly LaneState[],
  now: number
): { alarm: string[]; abort: string[]; dead: string[] } {
  const result = { alarm: [] as string[], abort: [] as string[], dead: [] as string[] };
  for (const lane of lanes) {
    const silent = now - lane.lastEventAt;
    if (lane.opening) {
      if (now - lane.startedAt > WATCHDOG_MS.opening) result.dead.push(lane.runId);
    } else if (!lane.busy) {
      if (silent > WATCHDOG_MS.deadLane) result.dead.push(lane.runId);
    } else if (silent > WATCHDOG_MS.runAbort) result.abort.push(lane.runId);
    else if (silent > WATCHDOG_MS.runAlarm && !lane.alarmed) result.alarm.push(lane.runId);
  }
  return result;
}

/**
 * Loops that have had ready work and no lane for WATCHDOG_MS.idleWithWork: alarm once per stretch. `stuck` is false
 * for a loop with a reason to wait (paused, capped, paced, backed off, the machine gate), so those never alarm.
 * Updates `since` (loopId -> stretch start) and `alarmed` in place.
 */
export function idleAlarms(
  loops: readonly { id: string; stuck: boolean }[],
  since: Map<string, number>,
  alarmed: Set<string>,
  now: number
): string[] {
  const alarms: string[] = [];
  for (const { id, stuck } of loops) {
    if (!stuck) {
      since.delete(id);
      alarmed.delete(id);
      continue;
    }
    const start = since.get(id) ?? now;
    since.set(id, start);
    if (now - start > WATCHDOG_MS.idleWithWork && !alarmed.has(id)) {
      alarmed.add(id);
      alarms.push(id);
    }
  }
  return alarms;
}

export const LOOP_MIN_MS = 30_000;
export const LOOP_MAX_MS = 86_400_000;

export const LOOP_UNTIL_MAX_MS = 7 * LOOP_MAX_MS;

export const LOOP_HELP =
  '/loop [interval] [--until <time>] <prompt or /skill> - repeat in this session while the app is open. ' +
  'Intervals: whole numbers with s, m, h or d, from 30s to 1d (e.g. /loop 5m /review). ' +
  'A duration-shaped first token is reserved for the interval; other text starts the prompt. ' +
  '--until ends the loop at a time today (18:00 or 6pm) or an ISO date-time (2026-05-01T09:00), at most 7 days ahead: ' +
  'no run starts at or after it. ' +
  'Omit the interval for model-selected pacing: each reply must end with LOOP_NEXT: <interval>. ' +
  'Missing or invalid decisions pause the loop. /loop list shows status; /loop stop cancels future runs. ' +
  'Runs wait for an idle session; delays start after completion, with no catch-up. ' +
  'Errors pause the loop. Start it again explicitly to resume. Loops never survive app restart or account changes.';

export interface LoopState {
  sessionId: string;
  prompt: string;
  intervalMs: number | null;
  phase: 'scheduled' | 'waiting' | 'running' | 'paused' | 'ended';
  nextRunAt: number | null;
  /** Epoch ms; no run starts at or after it. */
  until?: number;
  error?: string;
  /** Why an 'ended' loop ended. */
  notice?: string;
}

export type LoopResult = { ok: true; state: LoopState | null; notice?: string } | { ok: false; error: string };
export type LoopStart = { kind: 'start'; prompt: string; intervalMs: number | null; until?: number };
export type LoopAction = LoopStart | { kind: 'stop' } | { kind: 'list' } | { kind: 'help' };

const DURATION_SHAPE =
  /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:ms|s|m|h|d|seconds?|minutes?|hours?|days?)|NaN|Infinity)$/i;
const INVALID_INTERVAL = 'Invalid interval. Use whole s, m, h or d, from 30s to 1d.';
const INVALID_UNTIL =
  'Invalid end time. Use a time today such as 18:00 or 6pm, or an ISO date-time such as 2026-05-01T09:00.';

export function loopDuration(text: string): number | null {
  const match = /^(\d+)(s|m|h|d)$/.exec(text);
  if (!match) return null;
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: LOOP_MAX_MS }[match[2]];
  const value = Number(match[1]) * (multiplier ?? 0);
  return Number.isSafeInteger(value) && value >= LOOP_MIN_MS && value <= LOOP_MAX_MS ? value : null;
}

/** Resolves an end time to epoch ms: a clock time means today, a date-time without an offset is local. */
export function loopUntil(text: string, now = Date.now()): number | { error: string } {
  const value = text.trim();
  let at = Number.NaN;
  const clock = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(value);
  if (clock) {
    const [, hourText, minuteText, meridiem] = clock;
    let hour = Number(hourText);
    const minute = Number(minuteText ?? 0);
    const valid = meridiem ? hour >= 1 && hour <= 12 : minuteText !== undefined && hour <= 23;
    if (!valid || minute > 59) return { error: INVALID_UNTIL };
    if (meridiem) hour = (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
    at = new Date(now).setHours(hour, minute, 0, 0);
  } else {
    const stamp = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/i.exec(
      value
    );
    const [year, month, day, hour, minute] = (stamp ?? []).slice(1).map(Number);
    // Date.parse rolls an impossible day such as Feb 30 into the next month instead of refusing it.
    const real =
      stamp && month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (real && hour <= 23 && minute <= 59) at = Date.parse(value.replace(' ', 'T'));
  }
  if (!Number.isFinite(at)) return { error: INVALID_UNTIL };
  if (at <= now)
    return {
      error: `The end time ${formatLoopUntil(at, now)} has already passed. For a later day, give a date and time such as 2026-05-01T09:00.`,
    };
  if (at - now > LOOP_UNTIL_MAX_MS) return { error: 'The end time must be within 7 days.' };
  return at;
}

/** The validation every loop start shares, whether the user typed /loop or the agent called the tool. */
export function loopStart(
  prompt: string,
  interval?: string,
  until?: string,
  now = Date.now()
): LoopStart | { error: string } {
  let intervalMs: number | null = null;
  if (interval !== undefined) {
    intervalMs = loopDuration(interval);
    if (intervalMs === null) return { error: INVALID_INTERVAL };
  }
  const text = prompt.trim();
  if (!text) return { error: 'A loop needs a prompt or /skill after the interval.' };
  if (/^\/loop\b/i.test(text)) return { error: 'A loop cannot invoke another /loop.' };
  if (until === undefined) return { kind: 'start', prompt: text, intervalMs };
  const end = loopUntil(until, now);
  return typeof end === 'number' ? { kind: 'start', prompt: text, intervalMs, until: end } : end;
}

export function parseLoop(args: string, now = Date.now()): LoopAction | { error: string } {
  const text = args.trim();
  if (text === 'stop' || text === 'list' || text === 'help') return { kind: text };
  if (!text) return { error: `A loop needs a prompt. ${LOOP_HELP}` };
  // Options are read only from the front, so --until later in the prompt stays prompt text.
  let rest = text;
  let interval: string | undefined;
  let until: string | undefined;
  const next = (text: string) => /^(\S+)(?:\s+|$)/.exec(text);
  for (let token = next(rest); token; token = next(rest)) {
    if (interval === undefined && DURATION_SHAPE.test(token[1])) {
      interval = token[1];
      rest = rest.slice(token[0].length);
    } else if (until === undefined && token[1] === '--until') {
      const value = next(rest.slice(token[0].length));
      if (!value) return { error: 'Give --until a time, e.g. /loop 1h --until 18:00 <prompt>.' };
      until = value[1];
      rest = rest.slice(token[0].length + value[0].length);
    } else {
      break;
    }
  }
  return loopStart(rest, interval, until, now);
}

export function loopDecision(reply: string): number | null {
  const match = /(?:^|\n)LOOP_NEXT: (\S+)\s*$/.exec(reply);
  return match ? loopDuration(match[1]) : null;
}

export function formatLoopInterval(ms: number): string {
  for (const [unit, size] of [
    ['d', LOOP_MAX_MS],
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1000],
  ] as const) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms / 1000}s`;
}

export function formatLoopUntil(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

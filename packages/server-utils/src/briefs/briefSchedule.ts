/**
 * Brief schedule timing: when a user's next scheduled brief is due, and which activity window a brief
 * covers. Pure functions over IANA zone names; the process time zone is never read.
 */

export interface BriefScheduleTiming {
  enabled: boolean;
  /** Local wall-clock time, `HH:mm` (24h). */
  timeOfDay: string;
  /** Local weekdays, 0 = Sunday .. 6 = Saturday (JS `getDay`; Swift `Calendar` weekday - 1). */
  days: readonly number[];
  timeZone: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = DAY_MS;
export const BRIEF_MAX_WINDOW_MS = 7 * DAY_MS;

// Keyed by the ASCII-lowercased name: Intl matches zone names ASCII-case-insensitively and rejects unknown
// ones before anything is cached, so the cache is bounded by the zones and UTC offsets Intl accepts. A full
// toLowerCase() would fold a non-ASCII look-alike (KELVIN SIGN to "k") onto a cached zone Intl rejects.
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Number of cached zone formatters; exported for tests. */
export function cachedFormatterCount(): number {
  return formatters.size;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const key = timeZone.replace(/[A-Z]/g, c => c.toLowerCase());
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

function localParts(instantMs: number, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** UTC offset of `timeZone` at the instant, in ms (positive east of UTC). */
export function tzOffsetMs(instantMs: number, timeZone: string): number {
  const p = localParts(instantMs, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - (instantMs - (((instantMs % 1000) + 1000) % 1000));
}

/**
 * The UTC instant of a local wall-clock time. A time skipped by a spring-forward gap resolves forward by
 * the gap (02:30 becomes 03:30); a time repeated by a fall-back fold resolves to its earlier occurrence.
 */
export function localWallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const offsetBefore = tzOffsetMs(naive - DAY_MS, timeZone);
  const offsetAfter = tzOffsetMs(naive + DAY_MS, timeZone);
  const candidates = [naive - offsetBefore, naive - offsetAfter].filter(
    (candidate, i) => tzOffsetMs(candidate, timeZone) === (i === 0 ? offsetBefore : offsetAfter)
  );
  if (candidates.length === 0) return naive - offsetBefore;
  return Math.min(...candidates);
}

/**
 * The first scheduled instant strictly after `after`, so a slot that just fired advances to the next one.
 * Null when the schedule is disabled or names no days.
 */
export function computeNextBriefAt(schedule: BriefScheduleTiming, after: Date): Date | null {
  if (!schedule.enabled || schedule.days.length === 0) return null;
  const [hour, minute] = schedule.timeOfDay.split(':').map(Number);
  const afterMs = after.getTime();
  const today = localParts(afterMs, schedule.timeZone);

  for (let offset = 0; offset <= 7; offset++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (!schedule.days.includes(date.getUTCDay())) continue;
    const at = localWallToUtc(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      hour,
      minute,
      schedule.timeZone
    );
    if (at > afterMs) return new Date(at);
  }
  return null;
}

// Minimum gap an event start needs since the user's last automatic brief start, scheduled or event (ms).
export const BRIEF_MIN_GAP_MS = 4 * 60 * 60 * 1000;

/**
 * The gap a scheduled start needs since the last claim (ms). Only long enough to collapse a scheduled start
 * racing an event start into one brief, so an earlier event brief never uses up the user's chosen slot.
 */
export const SCHEDULED_BRIEF_MIN_GAP_MS = 15 * 60 * 1000;

/**
 * The activity window a brief covers: from the end of the last ready brief, capped at a week back, or
 * the last day when there is none. Shared by on-demand composition and the scheduler's pre-check.
 */
export function briefWindow(
  latestReadyEnd: Date | null | undefined,
  now: Date
): { periodStart: Date; periodEnd: Date } {
  const periodEnd = now;
  const earliest = periodEnd.getTime() - BRIEF_MAX_WINDOW_MS;
  const periodStart = latestReadyEnd
    ? new Date(Math.max(latestReadyEnd.getTime(), earliest))
    : new Date(periodEnd.getTime() - DEFAULT_WINDOW_MS);
  return { periodStart, periodEnd };
}

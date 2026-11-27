export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const BASELINE_DAYS = 7;
/** Silence needs a baseline this long: a younger app has not yet shown its weekend. */
export const SILENCE_MIN_HISTORY_DAYS = BASELINE_DAYS;
/** Hourly history the silence baseline sees. Two weeks, so a weekday-only app's previous weekend counts as a closed gap. */
export const GAP_LOOKBACK_DAYS = 14;

/** A client is armed once it has this many successes on at least ARM_MIN_ACTIVE_DAYS of the trailing 7 days. */
export const ARM_MIN_SUCCESSES = 5;
export const ARM_MIN_ACTIVE_DAYS = 3;
/** Failing: in the last hour, at least this many attempts and no success, or more than FAIL_RATE of them our fault. */
export const FAIL_MIN_ATTEMPTS = 5;
export const FAIL_RATE = 0.5;
/** Silent: hours since the last success exceed max(floor, multiplier x longest closed gap in the baseline). */
export const SILENCE_FLOOR_HOURS = 6;
export const SILENCE_MULTIPLIER = 2;
export const REMINDER_INTERVAL_MS = DAY_MS;
export const TOP_FAILURE_REASONS = 3;

export type SideAppAlertRule = 'failing' | 'silent';
export const PLATFORM_SCOPE = 'platform';
export const PLATFORM_RULE = 'all_down';

export interface HourlyBucket {
  /** Start of the clock hour, epoch ms. */
  hourStart: number;
  successes: number;
  failures: number;
  /** Failures that are ours: 5xx, failed or interrupted work, our-fault refusals. A subset of failures. */
  ourFaultFailures: number;
  /** Failure counts by reason label. */
  reasons?: Record<string, number>;
}

export interface WindowCounts {
  successes: number;
  failures: number;
  ourFaultFailures: number;
  reasons: Record<string, number>;
}

export interface ClientHealthInput {
  clientId: string;
  /** Hourly buckets covering the trailing GAP_LOOKBACK_DAYS, up to and including the current hour. */
  hourly: HourlyBucket[];
  /** The trailing 60 minutes, counted exactly rather than from clock-hour buckets. */
  lastHour: WindowCounts;
}

export interface ClientVerdict {
  clientId: string;
  armed: boolean;
  /** Failing wins over silent: a failing app is also silent, and one alert is enough. */
  rule: SideAppAlertRule | null;
  lastHour: WindowCounts;
  /** Whole and fractional hours since the last success, null when the baseline holds none. */
  hoursSinceSuccess: number | null;
  silenceThresholdHours: number;
  topReasons: Array<{ reason: string; count: number }>;
}

export const emptyWindowCounts = (): WindowCounts => ({
  successes: 0,
  failures: 0,
  ourFaultFailures: 0,
  reasons: {},
});

export function hourStartOf(epochMs: number): number {
  return epochMs - (((epochMs % HOUR_MS) + HOUR_MS) % HOUR_MS);
}

export function isArmed(hourly: HourlyBucket[], now: number): boolean {
  const successesByDay = new Map<number, number>();
  for (const bucket of hourly) {
    const day = Math.floor((now - bucket.hourStart) / DAY_MS);
    if (day < 0 || day >= BASELINE_DAYS || bucket.successes <= 0) continue;
    successesByDay.set(day, (successesByDay.get(day) ?? 0) + bucket.successes);
  }
  let activeDays = 0;
  for (const count of successesByDay.values()) if (count >= ARM_MIN_SUCCESSES) activeDays += 1;
  return activeDays >= ARM_MIN_ACTIVE_DAYS;
}

/**
 * Longest stretch of empty hours between two success hours. Only closed gaps count: the stretch
 * still open at `now` is the thing being judged, so it must not widen its own tolerance.
 */
export function longestClosedGapHours(hourly: HourlyBucket[]): number {
  const successHours = hourly
    .filter(bucket => bucket.successes > 0)
    .map(bucket => bucket.hourStart)
    .sort((a, b) => a - b);
  let longest = 0;
  for (let i = 1; i < successHours.length; i += 1) {
    longest = Math.max(longest, (successHours[i] - successHours[i - 1]) / HOUR_MS - 1);
  }
  return longest;
}

export const silenceThresholdHours = (longestClosedGap: number): number =>
  Math.max(SILENCE_FLOOR_HOURS, SILENCE_MULTIPLIER * longestClosedGap);

/** Hours with no success since the end of the latest success hour; null when there was none. */
export function hoursSinceLastSuccess(hourly: HourlyBucket[], now: number): number | null {
  let latest: number | null = null;
  for (const bucket of hourly) {
    if (bucket.successes > 0 && (latest === null || bucket.hourStart > latest)) latest = bucket.hourStart;
  }
  return latest === null ? null : Math.max(0, (now - (latest + HOUR_MS)) / HOUR_MS);
}

function hasHistoryOf(hourly: HourlyBucket[], now: number, days: number): boolean {
  let earliest: number | null = null;
  for (const bucket of hourly) {
    if (bucket.successes > 0 && (earliest === null || bucket.hourStart < earliest)) earliest = bucket.hourStart;
  }
  return earliest !== null && now - earliest > days * DAY_MS;
}

export function isFailingNow({ successes, failures, ourFaultFailures }: WindowCounts): boolean {
  const attempts = successes + failures;
  if (attempts < FAIL_MIN_ATTEMPTS) return false;
  return successes === 0 || ourFaultFailures / attempts > FAIL_RATE;
}

export function topFailureReasons(reasons: Record<string, number>, limit = TOP_FAILURE_REASONS) {
  return Object.entries(reasons)
    .filter(([, count]) => count > 0)
    .sort(([ar, ac], [br, bc]) => bc - ac || ar.localeCompare(br))
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

/**
 * `openRule` is the rule of this client's currently open alert, if any. An open `failing` alert
 * outlasts a quiet hour: it holds until an hour with a success that is not failing by rate.
 */
export function evaluateClient(input: ClientHealthInput, now: number, openRule?: string): ClientVerdict {
  const armed = isArmed(input.hourly, now);
  const threshold = silenceThresholdHours(longestClosedGapHours(input.hourly));
  const sinceSuccess = hoursSinceLastSuccess(input.hourly, now);
  const hasSilenceHistory = hasHistoryOf(input.hourly, now, SILENCE_MIN_HISTORY_DAYS);
  let rule: SideAppAlertRule | null = null;
  if (armed) {
    if (isFailingNow(input.lastHour)) rule = 'failing';
    else if (hasSilenceHistory && sinceSuccess !== null && sinceSuccess > threshold) rule = 'silent';
    else if (openRule === 'failing' && input.lastHour.successes === 0) rule = 'failing';
  }
  return {
    clientId: input.clientId,
    armed,
    rule,
    lastHour: input.lastHour,
    hoursSinceSuccess: sinceSuccess,
    silenceThresholdHours: threshold,
    topReasons: topFailureReasons(input.lastHour.reasons),
  };
}

export interface PlatformEvaluation {
  /** True when one "all side apps down" alert replaces the per-client ones. */
  platformDown: boolean;
  armed: ClientVerdict[];
}

/** With a single armed app its own alert serves, so the platform rule needs at least two. */
export function evaluatePlatform(verdicts: ClientVerdict[]): PlatformEvaluation {
  const armed = verdicts.filter(verdict => verdict.armed);
  return { platformDown: armed.length >= 2 && armed.every(verdict => verdict.rule !== null), armed };
}

export interface DesiredAlert {
  scope: string;
  rule: string;
  /** Held open but not announced, because a platform alert covers it. */
  muted: boolean;
  verdict?: ClientVerdict;
}

export interface OpenAlertKey {
  scope: string;
  rule: string;
}

/**
 * Every alert that should be open after this run. An open alert for a client that is no longer
 * armed stays desired until the client has a success again: losing arming is not recovery.
 * An open alert for a client with no verdict at all is not desired; see `untrackedAlerts`.
 */
export function desiredAlerts(verdicts: ClientVerdict[], open: OpenAlertKey[] = []): DesiredAlert[] {
  const { platformDown } = evaluatePlatform(verdicts);
  const alerts: DesiredAlert[] = verdicts
    .filter(verdict => verdict.rule !== null)
    .map(verdict => ({ scope: verdict.clientId, rule: verdict.rule as string, muted: platformDown, verdict }));
  const byClient = new Map(verdicts.map(verdict => [verdict.clientId, verdict]));
  for (const { scope, rule } of open) {
    if (scope === PLATFORM_SCOPE) continue;
    const verdict = byClient.get(scope);
    if (!verdict || verdict.armed) continue;
    if (verdict.hoursSinceSuccess !== null && verdict.hoursSinceSuccess < 1) continue;
    if (alerts.some(alert => alert.scope === scope && alert.rule === rule)) continue;
    alerts.push({ scope, rule, muted: platformDown, verdict });
  }
  if (platformDown) alerts.push({ scope: PLATFORM_SCOPE, rule: PLATFORM_RULE, muted: false });
  return alerts;
}

/** Open client alerts whose client has no hourly rows left in the lookback, so nothing can recover or sustain them. */
export function untrackedAlerts(verdicts: ClientVerdict[], open: OpenAlertKey[]): OpenAlertKey[] {
  const tracked = new Set(verdicts.map(verdict => verdict.clientId));
  return open.filter(({ scope }) => scope !== PLATFORM_SCOPE && !tracked.has(scope));
}

export function reminderDue(lastNotifiedAt: Date | undefined, now: number): boolean {
  return !lastNotifiedAt || now - lastNotifiedAt.getTime() >= REMINDER_INTERVAL_MS;
}

import { AnalyticsDaily, AnalyticsUserDay, type IAnalyticsDailySignups } from '@bike4mind/database';
import {
  ANALYTICS_MAX_CUSTOM_DAYS,
  ANALYTICS_STALE_AFTER_MS,
  type ActiveUsersDay,
  type AnalyticsBucket,
  type AnalyticsOverview,
  type AnalyticsOverviewQuery,
  type AnalyticsSignupsMode,
  type AnalyticsStat,
  type RequestsBySourceDay,
  type SignupBucket,
} from '@client/app/utils/analyticsOverview';
import {
  classifyCohort,
  collectDayUsage,
  formatDay,
  MAU_WINDOW_DAYS,
  shiftDay,
  WAU_WINDOW_DAYS,
} from './analyticsRollup';

const QUERY_DEADLINE_MS = 30_000;
// Per query: the live slice runs several stages in sequence, all inside the 60s API Lambda (infra/web.ts).
const LIVE_QUERY_DEADLINE_MS = 15_000;
const PRESET_DAYS = { '7d': 7, '28d': 28, '90d': 90, '12m': 365 } as const;
// Internal traffic, never a user-facing surface (spec 4.3).
const EXCLUDED_SOURCES = new Set(['system']);

/** A query the route should answer with 400; the message is safe to show. */
export class AnalyticsOverviewQueryError extends Error {}

export type OverviewWindow = AnalyticsOverview['window'];

const isValidDay = (day: string) => {
  try {
    return shiftDay(day, 0) === day;
  } catch {
    return false;
  }
};

const dayCount = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

export const daysBetween = (from: string, to: string): string[] =>
  from > to ? [] : Array.from({ length: dayCount(from, to) }, (_, index) => shiftDay(from, index));

function bucketFor(range: AnalyticsOverviewQuery['range'], length: number): AnalyticsBucket {
  if (range === '12m') return 'month';
  if (range === '90d') return 'week';
  if (range !== 'custom') return 'day';
  if (length > 120) return 'month';
  return length > 31 ? 'week' : 'day';
}

/**
 * The UTC days the query covers. Preset ranges end today; the last day is then partial and left out
 * of every comparison. The previous period is the same number of complete days right before `from`.
 */
export function resolveOverviewWindow(query: AnalyticsOverviewQuery, now: Date): OverviewWindow {
  const today = formatDay(now);
  let from: string;
  let to: string;
  if (query.range === 'custom') {
    if (!query.from || !query.to || !isValidDay(query.from) || !isValidDay(query.to)) {
      throw new AnalyticsOverviewQueryError('Pick a valid start and end date.');
    }
    if (query.from > query.to)
      throw new AnalyticsOverviewQueryError('The start date must be on or before the end date.');
    if (query.to > today) throw new AnalyticsOverviewQueryError('The end date cannot be after today (UTC).');
    if (dayCount(query.from, query.to) > ANALYTICS_MAX_CUSTOM_DAYS) {
      throw new AnalyticsOverviewQueryError(`A custom range can cover at most ${ANALYTICS_MAX_CUSTOM_DAYS} days.`);
    }
    ({ from, to } = query);
  } else {
    to = today;
    from = shiftDay(today, -(PRESET_DAYS[query.range] - 1));
  }
  const length = dayCount(from, to);
  const partialDay = to === today ? today : null;
  const completeDays = partialDay ? length - 1 : length;
  return {
    range: query.range,
    from,
    to,
    today,
    partialDay,
    completeDays,
    previous:
      query.compare === 'prev' && completeDays > 0
        ? { from: shiftDay(from, -completeDays), to: shiftDay(from, -1) }
        : null,
    bucket: bucketFor(query.range, length),
  };
}

export type OverviewDailyRow = {
  day: string;
  dau: number;
  wau: number;
  mau: number;
  signups: IAnalyticsDailySignups;
  requestsBySource: Record<string, number>;
  computedAt: Date;
};

/** Today's numbers, computed live with the rollup's own definitions. */
export type LiveDay = Omit<OverviewDailyRow, 'day' | 'computedAt'>;

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const mean = (values: readonly number[]) => (values.length ? sum(values) / values.length : null);
const signupTotal = (signups: IAnalyticsDailySignups, mode: AnalyticsSignupsMode) =>
  mode === 'legit' ? signups.legit : signups.legit + signups.suspected + signups.unclassified;

const mondayOf = (day: string) => shiftDay(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
const bucketStart = (day: string, bucket: AnalyticsBucket) =>
  bucket === 'day' ? day : bucket === 'week' ? mondayOf(day) : `${day.slice(0, 7)}-01`;
const nextBucketStart = (start: string, bucket: AnalyticsBucket) => {
  if (bucket === 'day') return shiftDay(start, 1);
  if (bucket === 'week') return shiftDay(start, 7);
  const date = new Date(`${start}T00:00:00Z`);
  return formatDay(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)));
};

/** Pure assembly of the overview from rollup rows and the live slice, so every rule is unit-testable. */
export function buildOverview({
  window,
  signupsMode,
  rows,
  live,
  now,
}: {
  window: OverviewWindow;
  signupsMode: AnalyticsSignupsMode;
  rows: readonly OverviewDailyRow[];
  live: LiveDay | null;
  now: Date;
}): AnalyticsOverview {
  // The live slice owns today even if a row for it was written early.
  const byDay = new Map(rows.filter(row => row.day < window.today).map(row => [row.day, row]));
  const valuesFor = (day: string): LiveDay | undefined =>
    day === window.partialDay ? (live ?? undefined) : byDay.get(day);

  const rangeDays = daysBetween(window.from, window.to);
  const completeDays =
    window.completeDays > 0 ? daysBetween(window.from, shiftDay(window.from, window.completeDays - 1)) : [];
  const previousDays = window.previous ? daysBetween(window.previous.from, window.previous.to) : [];
  const shiftBack = (day: string) => shiftDay(day, -window.completeDays);

  const days: ActiveUsersDay[] = rangeDays.map(day => {
    const values = valuesFor(day);
    return {
      day,
      dau: values?.dau ?? null,
      wau: values?.wau ?? null,
      mau: values?.mau ?? null,
      partial: day === window.partialDay,
      // shiftBack(partialDay) lands on window.from, inside the current range, so today has no comparison point.
      ...(window.previous
        ? { previousMau: day === window.partialDay ? null : (byDay.get(shiftBack(day))?.mau ?? null) }
        : {}),
    };
  });

  const sourceTotals = new Map<string, number>();
  const bySource: RequestsBySourceDay[] = rangeDays.map(day => {
    const values = valuesFor(day);
    if (!values) return { day, partial: day === window.partialDay, counts: null };
    const counts = Object.fromEntries(
      Object.entries(values.requestsBySource).filter(([source]) => !EXCLUDED_SOURCES.has(source))
    );
    for (const [source, count] of Object.entries(counts)) {
      sourceTotals.set(source, (sourceTotals.get(source) ?? 0) + count);
    }
    return { day, partial: day === window.partialDay, counts };
  });
  const sources = [...sourceTotals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);

  // MAU at the range end: the last complete day with a row, so a gap at the end does not blank the tile.
  const mauDay = [...completeDays].reverse().find(day => byDay.has(day));
  const presentDau = (list: readonly string[]) => list.flatMap(day => byDay.get(day)?.dau ?? []);
  const mau: AnalyticsStat = {
    value: mauDay ? (byDay.get(mauDay)?.mau ?? null) : null,
    previous: window.previous && mauDay ? (byDay.get(shiftBack(mauDay))?.mau ?? null) : null,
  };
  const avgDau: AnalyticsStat = {
    value: mean(presentDau(completeDays)),
    previous: window.previous ? mean(presentDau(previousDays)) : null,
  };
  const ratio = (dau: number | null, monthly: number | null) =>
    dau === null || monthly === null || monthly === 0 ? null : (dau / monthly) * 100;

  const signupRows = (list: readonly string[]) =>
    list.flatMap(day => {
      const values = valuesFor(day);
      return values ? [values.signups] : [];
    });
  const sumSignups = (list: readonly IAnalyticsDailySignups[], pick: (s: IAnalyticsDailySignups) => number) =>
    list.length ? sum(list.map(pick)) : null;
  const currentSignups = signupRows(completeDays);
  const previousSignups = signupRows(previousDays);

  const rangeSignups = signupRows(rangeDays);
  const bySignal = new Map<string, number>();
  for (const signups of rangeSignups) {
    for (const [signal, count] of Object.entries(signups.bySignal ?? {})) {
      bySignal.set(signal, (bySignal.get(signal) ?? 0) + count);
    }
  }

  const buckets: SignupBucket[] = [];
  const end = shiftDay(window.to, 1);
  for (let start = window.from; start < end;) {
    const next = nextBucketStart(bucketStart(start, window.bucket), window.bucket);
    const bucketEnd = next < end ? next : end;
    const inBucket = daysBetween(start, shiftDay(bucketEnd, -1));
    const present = signupRows(inBucket);
    buckets.push({
      start,
      end: bucketEnd,
      legit: sumSignups(present, s => s.legit),
      suspected: sumSignups(present, s => s.suspected),
      unclassified: sumSignups(present, s => s.unclassified),
      partial: window.partialDay !== null && inBucket.includes(window.partialDay),
    });
    start = bucketEnd;
  }

  const computedTimes = rows.filter(row => row.day <= window.to).map(row => new Date(row.computedAt).getTime());
  const lastUpdated = computedTimes.length ? new Date(Math.max(...computedTimes)) : null;

  return {
    window,
    signupsMode,
    lastUpdated: lastUpdated?.toISOString() ?? null,
    stale: !lastUpdated || now.getTime() - lastUpdated.getTime() > ANALYTICS_STALE_AFTER_MS,
    missingDays: completeDays.filter(day => !byDay.has(day)),
    stats: {
      mau,
      avgDau,
      stickiness: { value: ratio(avgDau.value, mau.value), previous: ratio(avgDau.previous, mau.previous) },
      newSignups: {
        value: sumSignups(currentSignups, s => signupTotal(s, signupsMode)),
        previous: window.previous ? sumSignups(previousSignups, s => signupTotal(s, signupsMode)) : null,
        suspected: sumSignups(currentSignups, s => s.suspected),
      },
    },
    activeUsers: { days, bySource, sources },
    signups: {
      buckets,
      totals: {
        legit: sum(rangeSignups.map(s => s.legit)),
        suspected: sum(rangeSignups.map(s => s.suspected)),
        unclassified: sum(rangeSignups.map(s => s.unclassified)),
      },
      bySignal: [...bySignal.entries()]
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([signal, count]) => ({ signal, count })),
    },
  };
}

async function distinctUsersBefore(today: string, windowDays: number): Promise<string[]> {
  return AnalyticsUserDay.distinct('userId', {
    day: { $gte: shiftDay(today, -(windowDays - 1)), $lt: today },
  }).maxTimeMS(LIVE_QUERY_DEADLINE_MS);
}

/** Today so far, with collectDayUsage and classifyCohort so it counts exactly what the nightly rollup will. */
export async function loadLiveDay(today: string, now: Date): Promise<LiveDay> {
  const [usage, cohort, weekIds, monthIds] = await Promise.all([
    collectDayUsage(today, { maxTimeMS: LIVE_QUERY_DEADLINE_MS }),
    classifyCohort(today, { now, maxTimeMS: LIVE_QUERY_DEADLINE_MS }),
    distinctUsersBefore(today, WAU_WINDOW_DAYS),
    distinctUsersBefore(today, MAU_WINDOW_DAYS),
  ]);
  const todayIds = [...usage.perUser.keys()];
  return {
    dau: todayIds.length,
    wau: new Set([...weekIds, ...todayIds]).size,
    mau: new Set([...monthIds, ...todayIds]).size,
    signups: cohort.signups,
    requestsBySource: Object.fromEntries(usage.bySource),
  };
}

export async function getAnalyticsOverview(
  query: AnalyticsOverviewQuery,
  now = new Date()
): Promise<AnalyticsOverview> {
  const window = resolveOverviewWindow(query, now);
  const earliest = window.previous?.from ?? window.from;
  const [rows, live] = await Promise.all([
    AnalyticsDaily.find({ day: { $gte: earliest, $lte: window.to } })
      .select('day dau wau mau signups requestsBySource computedAt')
      .maxTimeMS(QUERY_DEADLINE_MS)
      .lean<OverviewDailyRow[]>(),
    // A failed live slice leaves today as a gap, like a missing rollup day, instead of failing the page.
    window.partialDay
      ? loadLiveDay(window.partialDay, now).catch(error => {
          console.warn('analytics overview: live slice for today failed', error);
          return null;
        })
      : Promise.resolve(null),
  ]);
  return buildOverview({ window, signupsMode: query.signups, rows, live, now });
}

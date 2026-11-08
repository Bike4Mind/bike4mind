import { AnalyticsDaily, AnalyticsUserDay, type IAnalyticsDailySignups } from '@bike4mind/database';
import {
  COHORT_WEEK_OFFSETS,
  type AnalyticsCohorts,
  type AnalyticsCohortsQuery,
  type CohortCell,
  type CohortRow,
} from '@client/app/utils/analyticsCohorts';
import type { AnalyticsSignupsMode } from '@client/app/utils/analyticsOverview';
import { daysBetween, mondayOf } from './analyticsOverview';
import { formatDay, shiftDay } from './analyticsRollup';

const QUERY_DEADLINE_MS = 30_000;

const weekEnd = (weekStart: string) => shiftDay(weekStart, 6);

/**
 * Monday of each of the last `weeks` signup weeks that are over on `asOf`, oldest first. A week is over
 * when its Sunday is on or before `asOf`, so a cohort never gains members after it is shown.
 */
export function cohortWeekStarts(asOf: string, weeks: number): string[] {
  const monday = mondayOf(asOf);
  const lastOver = weekEnd(monday) <= asOf ? monday : shiftDay(monday, -7);
  return Array.from({ length: weeks }, (_, index) => shiftDay(lastOver, -7 * (weeks - 1 - index)));
}

/**
 * Counted signups of one day under the Signups toggle. "Legit only" is every counted signup that is not
 * suspected, because the active users are counted by `suspected: false` and the two must agree: a
 * signup too new to classify is `suspected: false` on its user-day rows. Differs from `signupTotal` in
 * analyticsOverview.ts, which leaves unclassified signups out of the legit count.
 */
export const cohortSignupCount = (signups: IAnalyticsDailySignups, mode: AnalyticsSignupsMode) =>
  mode === 'legit' ? signups.legit + signups.unclassified : signups.legit + signups.suspected + signups.unclassified;

export type CohortDailyRow = { day: string; signups: IAnalyticsDailySignups };
/** Distinct users active in `week` (a global week index) among those who signed up in cohort `cohort`. */
export type CohortActiveCount = { cohort: number; week: number; active: number };

/**
 * Pure assembly of the cohort table from rollup rows, so every rule is unit-testable. A cell is a gap
 * (null) unless its whole week is over and every day in it, and in the signup week, has a rollup row:
 * counting a half-rolled-up week would report a retention that is too low as if it were real.
 */
export function buildCohorts({
  asOf,
  weeks,
  mode,
  dailyRows,
  activeCounts,
}: {
  asOf: string;
  weeks: number;
  mode: AnalyticsSignupsMode;
  dailyRows: readonly CohortDailyRow[];
  activeCounts: readonly CohortActiveCount[];
}): Pick<AnalyticsCohorts, 'missingDays' | 'cohorts'> {
  const starts = cohortWeekStarts(asOf, weeks);
  const byDay = new Map(dailyRows.map(row => [row.day, row]));
  const active = new Map(activeCounts.map(count => [`${count.cohort}:${count.week}`, count.active]));

  const cohorts: CohortRow[] = starts.map((start, index) => {
    const signupDays = daysBetween(start, weekEnd(start));
    const size = signupDays.every(day => byDay.has(day))
      ? signupDays.reduce((total, day) => total + cohortSignupCount(byDay.get(day)!.signups, mode), 0)
      : null;
    const cells = Array.from({ length: COHORT_WEEK_OFFSETS }, (_, offset): CohortCell | null => {
      const from = shiftDay(start, 7 * offset);
      const to = weekEnd(from);
      if (size === null || size === 0 || to > asOf) return null;
      if (!daysBetween(from, to).every(day => byDay.has(day))) return null;
      const count = active.get(`${index}:${index + offset}`) ?? 0;
      return { active: count, percent: (count / size) * 100 };
    });
    return { week: start, size, cells };
  });

  return { missingDays: daysBetween(starts[0], asOf).filter(day => !byDay.has(day)), cohorts };
}

/** `$switch` that maps a `YYYY-MM-DD` field to the index of the Monday-to-Sunday week holding it, else -1. */
const weekIndexOf = (field: string, starts: readonly string[]) => ({
  $switch: {
    branches: starts.map((start, index) => ({
      case: { $and: [{ $gte: [field, start] }, { $lte: [field, weekEnd(start)] }] },
      then: index,
    })),
    default: -1,
  },
});

/**
 * Retention cohorts over the rollups: for each signup week, how many of its users were active in
 * each of the next weeks. Reads `analytics_user_days` (index `{ signupDay, day }`) and the daily
 * signup counts; both come from the nightly rollup, so the table is read through the last complete
 * day that was rolled up and never includes today's live slice.
 */
export async function getAnalyticsCohorts(
  query: AnalyticsCohortsQuery,
  now: Date = new Date()
): Promise<AnalyticsCohorts> {
  const empty = { signupsMode: query.signups, weeks: query.weeks, asOf: null, missingDays: [], cohorts: [] };
  const yesterday = shiftDay(formatDay(now), -1);
  const latest = await AnalyticsDaily.findOne({ day: { $lte: yesterday } }, { day: 1 })
    .sort({ day: -1 })
    .maxTimeMS(QUERY_DEADLINE_MS)
    .lean<{ day: string }>();
  if (!latest) return empty;
  const asOf = latest.day;

  const cohortStarts = cohortWeekStarts(asOf, query.weeks);
  const firstWeek = cohortStarts[0];
  const lastCohortEnd = weekEnd(cohortStarts[cohortStarts.length - 1]);
  const weekStarts: string[] = [];
  for (let start = firstWeek; start <= asOf; start = shiftDay(start, 7)) weekStarts.push(start);

  const [dailyRows, grouped] = await Promise.all([
    AnalyticsDaily.find({ day: { $gte: firstWeek, $lte: asOf } }, { day: 1, signups: 1, _id: 0 })
      .maxTimeMS(QUERY_DEADLINE_MS)
      .lean<CohortDailyRow[]>(),
    AnalyticsUserDay.aggregate<{ _id: { cohort: number; week: number }; active: number }>([
      {
        $match: {
          signupDay: { $gte: firstWeek, $lte: lastCohortEnd },
          day: { $gte: firstWeek, $lte: asOf },
          active: true,
          ...(query.signups === 'legit' ? { suspected: false } : {}),
        },
      },
      {
        $project: {
          _id: 0,
          userId: 1,
          cohort: weekIndexOf('$signupDay', cohortStarts),
          week: weekIndexOf('$day', weekStarts),
        },
      },
      { $match: { cohort: { $gte: 0 }, week: { $gte: 0 } } },
      { $group: { _id: { cohort: '$cohort', week: '$week', userId: '$userId' } } },
      { $group: { _id: { cohort: '$_id.cohort', week: '$_id.week' }, active: { $sum: 1 } } },
    ])
      .allowDiskUse(true)
      .option({ maxTimeMS: QUERY_DEADLINE_MS }),
  ]);

  return {
    signupsMode: query.signups,
    weeks: query.weeks,
    asOf,
    ...buildCohorts({
      asOf,
      weeks: query.weeks,
      mode: query.signups,
      dailyRows,
      activeCounts: grouped.map(row => ({ cohort: row._id.cohort, week: row._id.week, active: row.active })),
    }),
  };
}

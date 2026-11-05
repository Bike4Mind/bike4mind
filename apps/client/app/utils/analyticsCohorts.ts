import { z } from 'zod';
import { ANALYTICS_DEFAULTS, ANALYTICS_SIGNUPS, type AnalyticsSignupsMode } from './analyticsOverview';

/**
 * The admin Analytics retention cohorts: query and response shared by the route
 * (pages/api/admin/analytics/cohorts.ts), its server module (server/analytics/analyticsCohorts.ts)
 * and the page section (components/admin/Analytics/CohortsSection.tsx). Every day is a UTC
 * `YYYY-MM-DD`; every week starts on a Monday (UTC).
 */

/** Columns: week 0 (the signup week itself) to week 8. */
export const COHORT_WEEK_OFFSETS = 9;
export const COHORT_DEFAULT_WEEKS = 12;
export const COHORT_MAX_WEEKS = 26;

export const analyticsCohortsQuerySchema = z.object({
  weeks: z.coerce
    .number()
    .int('weeks must be a whole number.')
    .min(1, `weeks must be between 1 and ${COHORT_MAX_WEEKS}.`)
    .max(COHORT_MAX_WEEKS, `weeks must be between 1 and ${COHORT_MAX_WEEKS}.`)
    .default(COHORT_DEFAULT_WEEKS),
  signups: z.enum(ANALYTICS_SIGNUPS).default(ANALYTICS_DEFAULTS.signups),
});
export type AnalyticsCohortsQuery = z.infer<typeof analyticsCohortsQuerySchema>;

/** Users of the cohort active in the week, and that as a percent (0 to 100) of the cohort size. */
export type CohortCell = { active: number; percent: number };

export type CohortRow = {
  /** The Monday (UTC) of the signup week. */
  week: string;
  /**
   * Counted signups of the week. "Legit only" leaves out suspected signups and keeps accounts too new
   * to classify, so the size and the active counts follow the same rule. Null when the rollup is
   * missing for a day of the week.
   */
  size: number | null;
  /**
   * One entry per week offset. Null is a gap, never zero: the week is not over yet, a rollup day
   * inside it is missing, or the cohort is empty.
   */
  cells: (CohortCell | null)[];
};

export type AnalyticsCohorts = {
  signupsMode: AnalyticsSignupsMode;
  weeks: number;
  /** The last complete UTC day the cohorts are read through; null when nothing has been rolled up. */
  asOf: string | null;
  /** Days between the oldest cohort and `asOf` with no rollup row. */
  missingDays: string[];
  /** Oldest first. Only signup weeks that are over appear. */
  cohorts: CohortRow[];
};

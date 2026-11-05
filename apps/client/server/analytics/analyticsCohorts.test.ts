import { describe, expect, it } from 'vitest';
import type { IAnalyticsDailySignups } from '@bike4mind/database';
import { buildCohorts, cohortSignupCount, cohortWeekStarts, type CohortDailyRow } from './analyticsCohorts';
import { shiftDay } from './analyticsRollup';

// 2026-06-15 is a Monday.
const MONDAY = '2026-06-15';
const signups = (legit: number, suspected = 0, unclassified = 0): IAnalyticsDailySignups => ({
  legit,
  suspected,
  unclassified,
  bySignal: {},
});

/** One rollup row per day in [from, to]; `perDay` signups on each. */
const rollupRows = (from: string, to: string, perDay: IAnalyticsDailySignups): CohortDailyRow[] => {
  const rows: CohortDailyRow[] = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) rows.push({ day, signups: perDay });
  return rows;
};

describe('cohortWeekStarts', () => {
  it('ends at the last week that is over, oldest first', () => {
    // Sunday 2026-06-14 closes the week of 2026-06-08.
    expect(cohortWeekStarts('2026-06-14', 3)).toEqual(['2026-05-25', '2026-06-01', '2026-06-08']);
  });

  it('leaves out the week that is still running', () => {
    // Wednesday: the week of 2026-06-15 is not over, so the last cohort is the week before.
    expect(cohortWeekStarts('2026-06-17', 2)).toEqual(['2026-06-01', '2026-06-08']);
    expect(cohortWeekStarts(MONDAY, 1)).toEqual(['2026-06-08']);
  });

  it('always starts on a Monday', () => {
    for (const start of cohortWeekStarts('2026-03-04', 12)) {
      expect(new Date(`${start}T00:00:00Z`).getUTCDay()).toBe(1);
    }
  });
});

describe('cohortSignupCount', () => {
  it('counts every signup that is not suspected under "legit", and all of them under "all"', () => {
    expect(cohortSignupCount(signups(5, 2, 3), 'legit')).toBe(8);
    expect(cohortSignupCount(signups(5, 2, 3), 'all')).toBe(10);
  });
});

describe('buildCohorts', () => {
  const asOf = '2026-06-14'; // a Sunday: the week of 2026-06-08 just ended
  const complete = rollupRows('2026-05-04', asOf, signups(2));

  it('prints the percent of the cohort active in each week, with size from the daily signups', () => {
    const { cohorts, missingDays } = buildCohorts({
      asOf,
      weeks: 3,
      mode: 'legit',
      dailyRows: complete,
      // Cohort 0 is the week of 2026-05-25 (14 signups): 7 active in week 0, 14 in week 1.
      activeCounts: [
        { cohort: 0, week: 0, active: 7 },
        { cohort: 0, week: 1, active: 14 },
      ],
    });
    expect(missingDays).toEqual([]);
    expect(cohorts.map(row => row.week)).toEqual(['2026-05-25', '2026-06-01', '2026-06-08']);
    expect(cohorts[0].size).toBe(14);
    expect(cohorts[0].cells[0]).toEqual({ active: 7, percent: 50 });
    expect(cohorts[0].cells[1]).toEqual({ active: 14, percent: 100 });
  });

  it('leaves future cells blank, not zero', () => {
    const { cohorts } = buildCohorts({ asOf, weeks: 3, mode: 'legit', dailyRows: complete, activeCounts: [] });
    // Cohort 0 (week of 2026-05-25) has weeks 0 to 2 behind it, the last ending on asOf (2026-06-14).
    for (const offset of [0, 1, 2]) expect(cohorts[0].cells[offset]).toEqual({ active: 0, percent: 0 });
    expect(cohorts[0].cells.slice(3)).toEqual(Array(6).fill(null));
    // The newest cohort only has its own week.
    expect(cohorts[2].cells[0]).not.toBeNull();
    expect(cohorts[2].cells.slice(1)).toEqual(Array(8).fill(null));
  });

  it('keeps a real zero as a zero cell, distinct from a blank one', () => {
    const { cohorts } = buildCohorts({ asOf, weeks: 1, mode: 'legit', dailyRows: complete, activeCounts: [] });
    expect(cohorts[0].cells[0]).toEqual({ active: 0, percent: 0 });
    expect(cohorts[0].cells[1]).toBeNull();
  });

  it('blanks the whole row of an empty cohort', () => {
    const { cohorts } = buildCohorts({
      asOf,
      weeks: 1,
      mode: 'legit',
      dailyRows: rollupRows('2026-05-04', asOf, signups(0)),
      activeCounts: [],
    });
    expect(cohorts[0].size).toBe(0);
    expect(cohorts[0].cells).toEqual(Array(9).fill(null));
  });

  it('blanks a cell, and the size, when a rollup day it depends on is missing', () => {
    const gap = '2026-06-03'; // inside the second week of cohort 0, and the signup week of cohort 1
    const { cohorts, missingDays } = buildCohorts({
      asOf,
      weeks: 3,
      mode: 'legit',
      dailyRows: complete.filter(row => row.day !== gap),
      activeCounts: [
        { cohort: 0, week: 0, active: 5 },
        { cohort: 0, week: 1, active: 5 },
      ],
    });
    expect(missingDays).toContain(gap);
    expect(cohorts[0].cells[0]).toEqual({ active: 5, percent: (5 / 14) * 100 });
    expect(cohorts[0].cells[1]).toBeNull();
    expect(cohorts[1].size).toBeNull();
    expect(cohorts[1].cells).toEqual(Array(9).fill(null));
  });

  it('counts the cohort per the Signups toggle', () => {
    const rows = rollupRows('2026-05-04', asOf, signups(2, 1, 1));
    const legit = buildCohorts({ asOf, weeks: 1, mode: 'legit', dailyRows: rows, activeCounts: [] });
    const all = buildCohorts({ asOf, weeks: 1, mode: 'all', dailyRows: rows, activeCounts: [] });
    expect(legit.cohorts[0].size).toBe(21); // (2 + 1) x 7
    expect(all.cohorts[0].size).toBe(28); // (2 + 1 + 1) x 7
  });
});

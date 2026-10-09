import { describe, it, expect } from 'vitest';
import type { QaRunSummary } from '@client/app/hooks/data/qaStatus';
import { dayLabel, groupRuns, isFailingRun, localDayKey } from './runGroups';

const counts = { passed: 10, failed: 0, skipped: 0, notStarted: 0, ran: 10, total: 10 };
const run = (o: Partial<QaRunSummary> = {}): QaRunSummary => ({
  id: 'r',
  product: 'product-a',
  suite: 'Core',
  env: 'staging',
  branch: 'main',
  trigger: 'ci',
  source: 'ci',
  status: 'passed',
  startedAt: new Date(2026, 9, 6, 9).toISOString(),
  durationMs: 1000,
  counts,
  ciRunUrl: '',
  sha: 'abc',
  ...o,
});

describe('isFailingRun', () => {
  it('fails on failed tests or a failed status, not on infra-error alone', () => {
    expect(isFailingRun(run())).toBe(false);
    expect(isFailingRun(run({ counts: { ...counts, failed: 1 } }))).toBe(true);
    expect(isFailingRun(run({ status: 'failed' }))).toBe(true);
    expect(isFailingRun(run({ status: 'infra-error' }))).toBe(false);
    expect(isFailingRun(run({ status: 'infra-error', counts: { ...counts, failed: 1 } }))).toBe(true);
  });
});

describe('dayLabel', () => {
  const now = new Date(2026, 9, 6, 12);
  it('names today and yesterday, dates the rest', () => {
    expect(dayLabel(new Date(2026, 9, 6), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 9, 5), now)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 9, 3), now)).toMatch(/Oct.*3|3.*Oct/);
  });
  it('rolls yesterday across a month boundary', () => {
    expect(dayLabel(new Date(2026, 8, 30), new Date(2026, 9, 1, 8))).toBe('Yesterday');
  });
});

describe('groupRuns', () => {
  it('keys days on the local date', () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localDayKey(new Date(2026, 0, 6, 0, 1))).toBe('2026-01-06');
  });

  it('counts runs and failing runs per day and suite', () => {
    const days = groupRuns([
      run({ id: 'a', suite: 'Core', startedAt: new Date(2026, 9, 6, 9).toISOString(), status: 'failed' }),
      run({ id: 'b', suite: 'Core', startedAt: new Date(2026, 9, 6, 10).toISOString() }),
      run({ id: 'c', suite: 'Auth', startedAt: new Date(2026, 9, 5, 10).toISOString(), status: 'failed' }),
    ]);
    expect(days.map(d => [d.key, d.runCount, d.failed])).toEqual([
      ['2026-10-06', 2, 1],
      ['2026-10-05', 1, 1],
    ]);
    expect(days[0].suites).toHaveLength(1);
    expect(days[0].suites[0].runs.map(r => r.id)).toEqual(['b', 'a']);
    expect(days[0].suites[0].failed).toBe(1);
  });

  it('returns nothing for no runs', () => {
    expect(groupRuns([])).toEqual([]);
  });
});

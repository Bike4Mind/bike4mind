import { describe, expect, it } from 'vitest';
import type { AnalyticsOverviewQuery } from '@client/app/utils/analyticsOverview';
import {
  AnalyticsOverviewQueryError,
  buildOverview,
  daysBetween,
  resolveOverviewWindow,
  type LiveDay,
  type OverviewDailyRow,
} from './analyticsOverview';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const query = (patch: Partial<AnalyticsOverviewQuery> = {}): AnalyticsOverviewQuery => ({
  range: '7d',
  compare: 'prev',
  signups: 'legit',
  ...patch,
});

const row = (day: string, patch: Partial<OverviewDailyRow> = {}): OverviewDailyRow => ({
  day,
  dau: 10,
  wau: 20,
  mau: 40,
  signups: { legit: 2, suspected: 1, unclassified: 0, bySignal: { domainBurst: 1 } },
  requestsBySource: { web: 5, cli: 1, system: 9 },
  computedAt: new Date('2026-06-15T04:00:00.000Z'),
  ...patch,
});

const live: LiveDay = {
  dau: 3,
  wau: 25,
  mau: 45,
  signups: { legit: 0, suspected: 0, unclassified: 4, bySignal: {} },
  requestsBySource: { web: 2 },
};

const rowsFor = (from: string, to: string, patch?: (day: string) => Partial<OverviewDailyRow>) =>
  daysBetween(from, to).map(day => row(day, patch?.(day)));

describe('resolveOverviewWindow', () => {
  it('ends a preset range today, marks today partial and compares the complete days before it', () => {
    expect(resolveOverviewWindow(query(), NOW)).toEqual({
      range: '7d',
      from: '2026-06-09',
      to: '2026-06-15',
      today: '2026-06-15',
      partialDay: '2026-06-15',
      completeDays: 6,
      previous: { from: '2026-06-03', to: '2026-06-08' },
      bucket: 'day',
    });
  });

  it.each([
    ['28d', '2026-05-19', 'day'],
    ['90d', '2026-03-18', 'week'],
    ['12m', '2025-06-16', 'month'],
  ] as const)('%s starts on %s with %s buckets', (range, from, bucket) => {
    const window = resolveOverviewWindow(query({ range }), NOW);
    expect(window.from).toBe(from);
    expect(window.bucket).toBe(bucket);
  });

  it('drops the previous period when compare is off', () => {
    expect(resolveOverviewWindow(query({ compare: 'off' }), NOW).previous).toBeNull();
  });

  it('takes a custom range in the past as complete days and sizes its buckets by length', () => {
    const window = resolveOverviewWindow(query({ range: 'custom', from: '2026-01-01', to: '2026-01-10' }), NOW);
    expect(window).toMatchObject({ partialDay: null, completeDays: 10, bucket: 'day' });
    expect(window.previous).toEqual({ from: '2025-12-22', to: '2025-12-31' });
    expect(resolveOverviewWindow(query({ range: 'custom', from: '2026-01-01', to: '2026-03-01' }), NOW).bucket).toBe(
      'week'
    );
    expect(resolveOverviewWindow(query({ range: 'custom', from: '2025-07-01', to: '2026-03-01' }), NOW).bucket).toBe(
      'month'
    );
  });

  it.each([
    [{ from: '2026-02-30', to: '2026-03-01' }, 'Pick a valid start and end date.'],
    [{ from: '2026-03-02', to: '2026-03-01' }, 'The start date must be on or before the end date.'],
    [{ from: '2026-06-01', to: '2026-06-16' }, 'The end date cannot be after today (UTC).'],
    [{ from: '2025-01-01', to: '2026-06-01' }, 'A custom range can cover at most 366 days.'],
  ])('rejects a custom range %o', (dates, message) => {
    expect(() => resolveOverviewWindow(query({ range: 'custom', ...dates }), NOW)).toThrow(
      new AnalyticsOverviewQueryError(message)
    );
  });

  it('has no complete days and no comparison when a custom range is only today', () => {
    const window = resolveOverviewWindow(query({ range: 'custom', from: '2026-06-15', to: '2026-06-15' }), NOW);
    expect(window).toMatchObject({ completeDays: 0, previous: null, partialDay: '2026-06-15' });
  });
});

describe('buildOverview', () => {
  const build = (q: AnalyticsOverviewQuery, rows: OverviewDailyRow[], liveDay: LiveDay | null = live) =>
    buildOverview({ window: resolveOverviewWindow(q, NOW), signupsMode: q.signups, rows, live: liveDay, now: NOW });

  it('reads tiles from complete days only and compares them with the previous period', () => {
    const rows = [
      ...rowsFor('2026-06-03', '2026-06-08', () => ({ dau: 5, mau: 20 })),
      ...rowsFor('2026-06-09', '2026-06-14', day => ({ dau: day === '2026-06-14' ? 16 : 10, mau: 40 })),
    ];
    const overview = build(query(), rows);
    expect(overview.stats.mau).toEqual({ value: 40, previous: 20 });
    expect(overview.stats.avgDau).toEqual({ value: 11, previous: 5 });
    expect(overview.stats.stickiness.value).toBeCloseTo(27.5);
    expect(overview.stats.stickiness.previous).toBeCloseTo(25);
    // Six complete days of 2 legit, 1 suspected each; today's live signups stay out of the tile.
    expect(overview.stats.newSignups).toEqual({ value: 12, previous: 12, suspected: 6 });
  });

  it('draws today from the live slice, flagged partial, and ignores an early rollup row for it', () => {
    const overview = build(query(), [
      ...rowsFor('2026-06-09', '2026-06-14'),
      row('2026-06-15', { dau: 999, computedAt: new Date('2026-06-15T05:00:00Z') }),
    ]);
    const today = overview.activeUsers.days.at(-1);
    expect(today).toMatchObject({ day: '2026-06-15', dau: 3, wau: 25, mau: 45, partial: true });
    expect(overview.activeUsers.days.filter(day => day.partial)).toHaveLength(1);
    expect(overview.signups.buckets.at(-1)).toMatchObject({ start: '2026-06-15', unclassified: 4, partial: true });
  });

  it('leaves a missing rollup day as a gap, never zero, and lists it', () => {
    const rows = rowsFor('2026-06-09', '2026-06-14').filter(r => r.day !== '2026-06-11');
    const overview = build(query({ compare: 'off' }), rows);
    expect(overview.missingDays).toEqual(['2026-06-11']);
    expect(overview.activeUsers.days.find(day => day.day === '2026-06-11')).toMatchObject({
      dau: null,
      wau: null,
      mau: null,
    });
    expect(overview.signups.buckets.find(b => b.start === '2026-06-11')).toMatchObject({
      legit: null,
      suspected: null,
    });
    expect(overview.activeUsers.bySource.find(day => day.day === '2026-06-11')?.counts).toBeNull();
    // The mean skips the gap rather than counting it as zero.
    expect(overview.stats.avgDau.value).toBe(10);
  });

  it('falls back to the last rolled-up day for MAU when the range ends in a gap', () => {
    const rows = rowsFor('2026-06-09', '2026-06-13', day => ({ mau: day === '2026-06-13' ? 33 : 40 }));
    const overview = build(query({ compare: 'off' }), rows);
    expect(overview.stats.mau.value).toBe(33);
    expect(overview.missingDays).toEqual(['2026-06-14']);
  });

  it('returns null tiles when the range has no rollup at all', () => {
    const overview = build(query(), []);
    expect(overview.stats.mau).toEqual({ value: null, previous: null });
    expect(overview.stats.avgDau.value).toBeNull();
    expect(overview.stats.stickiness.value).toBeNull();
    expect(overview.stats.newSignups.value).toBeNull();
    expect(overview.lastUpdated).toBeNull();
    expect(overview.stale).toBe(true);
  });

  it('counts legit signups by default and every signup in all mode', () => {
    const rows = rowsFor('2026-06-09', '2026-06-14', () => ({
      signups: { legit: 2, suspected: 1, unclassified: 3, bySignal: {} },
    }));
    expect(build(query(), rows).stats.newSignups.value).toBe(12);
    expect(build(query({ signups: 'all' }), rows).stats.newSignups.value).toBe(36);
    expect(build(query({ signups: 'all' }), rows).stats.newSignups.suspected).toBe(6);
  });

  it('adds the previous period MAU at the same position for the comparison line', () => {
    const rows = [
      ...rowsFor('2026-06-03', '2026-06-08', day => ({ mau: Number(day.slice(-2)) })),
      ...rowsFor('2026-06-09', '2026-06-14'),
    ];
    const overview = build(query(), rows);
    expect(overview.activeUsers.days[0]).toMatchObject({ day: '2026-06-09', previousMau: 3 });
    expect(overview.activeUsers.days.at(-1)).toMatchObject({ day: '2026-06-15', partial: true, previousMau: null });
    expect(build(query({ compare: 'off' }), rows).activeUsers.days[0]).not.toHaveProperty('previousMau');
  });

  it('drops system traffic from the surface breakdown and orders surfaces by volume', () => {
    const overview = build(query({ compare: 'off' }), rowsFor('2026-06-09', '2026-06-14'));
    expect(overview.activeUsers.sources).toEqual(['web', 'cli']);
    expect(overview.activeUsers.bySource[0].counts).toEqual({ web: 5, cli: 1 });
  });

  it('buckets 90 days by ISO week (Monday UTC), clipped to the range', () => {
    const overview = build(query({ range: '90d', compare: 'off' }), rowsFor('2026-03-18', '2026-06-14'));
    const buckets = overview.signups.buckets;
    // 2026-03-18 is a Wednesday: the first bucket runs to the next Monday.
    expect(buckets[0]).toMatchObject({ start: '2026-03-18', end: '2026-03-23', legit: 10 });
    expect(buckets[1]).toMatchObject({ start: '2026-03-23', end: '2026-03-30', legit: 14 });
    expect(buckets.at(-1)).toMatchObject({ start: '2026-06-15', end: '2026-06-16', partial: true });
  });

  it('buckets 12 months by calendar month', () => {
    const overview = build(query({ range: '12m', compare: 'off' }), rowsFor('2025-06-16', '2026-06-14'));
    const buckets = overview.signups.buckets;
    expect(buckets[0]).toMatchObject({ start: '2025-06-16', end: '2025-07-01', legit: 30 });
    expect(buckets[1]).toMatchObject({ start: '2025-07-01', end: '2025-08-01', legit: 62 });
    expect(buckets.at(-1)).toMatchObject({ start: '2026-06-01', end: '2026-06-16', partial: true });
  });

  it('sums signals over the range, largest first', () => {
    const rows = rowsFor('2026-06-09', '2026-06-14', day => ({
      signups: {
        legit: 1,
        suspected: 1,
        unclassified: 0,
        bySignal: day === '2026-06-09' ? { signupSpike: 4, domainBurst: 1 } : { domainBurst: 1, wafBotSignal: 0 },
      },
    }));
    expect(build(query(), rows).signups.bySignal).toEqual([
      { signal: 'domainBurst', count: 6 },
      { signal: 'signupSpike', count: 4 },
    ]);
  });

  it('reports the newest computedAt and flags it stale after 30 hours', () => {
    const fresh = build(query(), rowsFor('2026-06-09', '2026-06-14'));
    expect(fresh.lastUpdated).toBe('2026-06-15T04:00:00.000Z');
    expect(fresh.stale).toBe(false);
    const old = build(
      query(),
      rowsFor('2026-06-09', '2026-06-12', () => ({ computedAt: new Date('2026-06-14T05:59:00Z') }))
    );
    expect(old.stale).toBe(true);
  });
});

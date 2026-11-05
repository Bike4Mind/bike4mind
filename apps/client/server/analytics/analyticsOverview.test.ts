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
  accounts: 'external',
  ...patch,
});

const row = (day: string, patch: Partial<OverviewDailyRow> = {}): OverviewDailyRow => ({
  day,
  dau: 10,
  wau: 20,
  mau: 40,
  signups: { legit: 2, suspected: 1, bySignal: { domainBurst: 1 } },
  requestsBySource: { web: 5, cli: 1, system: 9 },
  // One internal user was external earlier in the window, so the union is one less than the sum.
  internal: {
    dau: 2,
    wau: 3,
    mau: 4,
    allWau: 22,
    allMau: 43,
    windowComplete: true,
    requestsBySource: { web: 1, desktop: 2 },
  },
  computedAt: new Date('2026-06-15T04:00:00.000Z'),
  ...patch,
});

const live: LiveDay = {
  dau: 3,
  wau: 25,
  mau: 45,
  signups: { legit: 0, suspected: 4, bySignal: {} },
  api: { dau: 2, wau: 3, mau: 4 },
  requestsBySource: { web: 2 },
  internal: { dau: 1, wau: 3, mau: 5, allWau: 27, allMau: 49, windowComplete: true, requestsBySource: { cli: 1 } },
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

  it('accepts a custom range of exactly 366 days, both ends included', () => {
    const window = resolveOverviewWindow(query({ range: 'custom', from: '2025-06-01', to: '2026-06-01' }), NOW);
    expect(window.completeDays).toBe(366);
  });

  it('rejects a custom range of 367 days, both ends included', () => {
    expect(() => resolveOverviewWindow(query({ range: 'custom', from: '2025-05-31', to: '2026-06-01' }), NOW)).toThrow(
      new AnalyticsOverviewQueryError('A custom range can cover at most 366 days.')
    );
  });

  it('has no complete days and no comparison when a custom range is only today', () => {
    const window = resolveOverviewWindow(query({ range: 'custom', from: '2026-06-15', to: '2026-06-15' }), NOW);
    expect(window).toMatchObject({ completeDays: 0, previous: null, partialDay: '2026-06-15' });
  });
});

describe('buildOverview', () => {
  const build = (q: AnalyticsOverviewQuery, rows: OverviewDailyRow[], liveDay: LiveDay | null = live) =>
    buildOverview({
      window: resolveOverviewWindow(q, NOW),
      signupsMode: q.signups,
      accounts: q.accounts,
      rows,
      live: liveDay,
      now: NOW,
    });

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
    expect(overview.signups.buckets.at(-1)).toMatchObject({ start: '2026-06-15', suspected: 4, partial: true });
  });

  it('passes the API series through, leaves it a gap for a row without one, and keeps it out of the counts', () => {
    const overview = build(query(), [
      ...rowsFor('2026-06-09', '2026-06-13', () => ({ api: { dau: 7, wau: 8, mau: 9 } })),
      row('2026-06-14'),
    ]);
    expect(overview.activeUsers.days.map(day => day.apiDau)).toEqual([7, 7, 7, 7, 7, null, 2]);
    expect(overview.stats.avgDau.value).toBe(10);
    expect(overview.signups.totals).toEqual({ legit: 12, suspected: 10 });
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
      signups: { legit: 2, suspected: 1, bySignal: {} },
    }));
    expect(build(query(), rows).stats.newSignups.value).toBe(12);
    expect(build(query({ signups: 'all' }), rows).stats.newSignups.value).toBe(18);
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

  it('leaves previousMau empty for the partial day instead of reaching back to the window start', () => {
    const rows = [...rowsFor('2026-06-01', '2026-06-08'), ...rowsFor('2026-06-09', '2026-06-14')];
    const days = build(query(), rows).activeUsers.days;
    expect(days.at(-1)).toMatchObject({ day: '2026-06-15', partial: true, previousMau: null });
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
        bySignal: day === '2026-06-09' ? { signupSpike: 4, domainBurst: 1 } : { domainBurst: 1, wafBotSignal: 0 },
      },
    }));
    expect(build(query(), rows).signups.bySignal).toEqual([
      { signal: 'domainBurst', count: 6 },
      { signal: 'signupSpike', count: 4 },
    ]);
  });

  it('counts only internal accounts in internal mode, tiles and surfaces included', () => {
    const overview = build(query({ accounts: 'internal' }), rowsFor('2026-06-03', '2026-06-14'));
    expect(overview.accounts).toBe('internal');
    expect(overview.activeUsers.days[0]).toMatchObject({ dau: 2, wau: 3, mau: 4, previousMau: 4 });
    expect(overview.activeUsers.days.at(-1)).toMatchObject({ dau: 1, wau: 3, mau: 5, partial: true });
    expect(overview.stats.mau).toEqual({ value: 4, previous: 4 });
    expect(overview.stats.avgDau.value).toBe(2);
    expect(overview.activeUsers.bySource[0].counts).toEqual({ web: 1, desktop: 2 });
    // Signups never include internal accounts, so the toggle leaves them alone.
    expect(overview.stats.newSignups.value).toBe(12);
  });

  it('sums DAU in all mode, takes WAU and MAU from the stored union and merges surfaces', () => {
    const overview = build(query({ accounts: 'all', compare: 'off' }), rowsFor('2026-06-09', '2026-06-14'));
    expect(overview.activeUsers.days[0]).toMatchObject({ dau: 12, wau: 22, mau: 43 });
    expect(overview.activeUsers.days.at(-1)).toMatchObject({ dau: 4, wau: 27, mau: 49 });
    expect(overview.activeUsers.bySource[0].counts).toEqual({ web: 6, cli: 1, desktop: 2 });
    expect(overview.activeUsers.bySource.at(-1)?.counts).toEqual({ web: 2, cli: 1 });
    expect(overview.stats.mau.value).toBe(43);
  });

  it('returns both sides of every day for the hover, whatever the selection', () => {
    for (const accounts of ['external', 'internal', 'all'] as const) {
      const days = build(query({ accounts, compare: 'off' }), rowsFor('2026-06-09', '2026-06-14')).activeUsers.days;
      expect(days[0]).toMatchObject({
        external: { dau: 10, wau: 20, mau: 40 },
        internal: { dau: 2, wau: 3, mau: 4 },
      });
      expect(days.at(-1)).toMatchObject({
        external: { dau: 3, wau: 25, mau: 45 },
        internal: { dau: 1, wau: 3, mau: 5 },
      });
    }
  });

  it('treats a row without internal counts as a gap for internal and all, but not for external', () => {
    const rows = rowsFor('2026-06-09', '2026-06-14', day => (day === '2026-06-11' ? { internal: undefined } : {}));
    const external = build(query({ compare: 'off' }), rows);
    expect(external.missingDays).toEqual([]);
    expect(external.internalMissingDays).toEqual([]);
    expect(external.activeUsers.days.find(day => day.day === '2026-06-11')).toMatchObject({ dau: 10, internal: null });
    for (const accounts of ['internal', 'all'] as const) {
      const overview = build(query({ accounts, compare: 'off' }), rows);
      expect(overview.missingDays).toEqual([]);
      expect(overview.internalMissingDays).toEqual(['2026-06-11']);
      expect(overview.activeUsers.days.find(day => day.day === '2026-06-11')).toMatchObject({
        dau: null,
        mau: null,
        external: { dau: 10, wau: 20, mau: 40 },
        internal: null,
      });
      expect(overview.activeUsers.bySource.find(day => day.day === '2026-06-11')?.counts).toBeNull();
      expect(overview.signups.buckets.find(b => b.start === '2026-06-11')?.legit).toBe(2);
    }
  });

  it('treats internal counts over an incomplete window as a gap, today included', () => {
    const rows = rowsFor('2026-06-09', '2026-06-14', day =>
      day === '2026-06-13' ? { internal: { ...row(day).internal!, windowComplete: false } } : {}
    );
    const liveDay: LiveDay = { ...live, internal: { ...live.internal!, windowComplete: false } };
    const overview = build(query({ accounts: 'internal', compare: 'off' }), rows, liveDay);
    expect(overview.internalMissingDays).toEqual(['2026-06-13', '2026-06-15']);
    expect(overview.activeUsers.days.find(day => day.day === '2026-06-13')).toMatchObject({
      dau: null,
      internal: null,
    });
    expect(overview.activeUsers.days.at(-1)).toMatchObject({ partial: true, dau: null, internal: null });
    expect(overview.activeUsers.days.at(-1)?.external).toEqual({ dau: 3, wau: 25, mau: 45 });
  });

  it.each(['internal', 'all'] as const)('reports incomplete live history in a today-only %s range', accounts => {
    const todayOnly = query({ accounts, range: 'custom', from: '2026-06-15', to: '2026-06-15' });
    const liveDay: LiveDay = { ...live, internal: { ...live.internal!, windowComplete: false } };
    const overview = build(todayOnly, [], liveDay);
    expect(overview.missingDays).toEqual([]);
    expect(overview.internalMissingDays).toEqual(['2026-06-15']);
    expect(overview.activeUsers.days[0]).toMatchObject({ dau: null, internal: null, partial: true });
    expect(build({ ...todayOnly, accounts: 'external' }, [], liveDay).internalMissingDays).toEqual([]);
    expect(build(todayOnly, [], null).internalMissingDays).toEqual([]);
    expect(build(todayOnly, [], live).internalMissingDays).toEqual([]);
  });

  it('keeps a day with no rollup row in missingDays only, whatever the selection', () => {
    const rows = rowsFor('2026-06-09', '2026-06-14').filter(r => r.day !== '2026-06-10');
    const overview = build(query({ accounts: 'all', compare: 'off' }), rows);
    expect(overview.missingDays).toEqual(['2026-06-10']);
    expect(overview.internalMissingDays).toEqual([]);
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

  it('never flags a fully past custom range stale, however old its rollup', () => {
    const past = build(
      query({ range: 'custom', from: '2026-01-01', to: '2026-01-31', compare: 'off' }),
      rowsFor('2026-01-01', '2026-01-31', () => ({ computedAt: new Date('2026-02-01T04:00:00Z') }))
    );
    expect(past.stale).toBe(false);
  });
});

import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsOverview, AnalyticsTopAccounts } from '@client/app/utils/analyticsOverview';

const download = vi.hoisted(() => ({ downloadData: vi.fn() }));
vi.mock('@client/app/utils/download', () => download);

import { buildAnalyticsCsvFiles, downloadAnalyticsExport } from './analyticsExport';

const overview = {
  window: {
    range: '7d',
    from: '2026-06-09',
    to: '2026-06-15',
    today: '2026-06-15',
    partialDay: '2026-06-15',
    completeDays: 6,
    previous: null,
    bucket: 'day',
  },
  signupsMode: 'legit',
  lastUpdated: null,
  stale: false,
  missingDays: ['2026-06-14'],
  stats: {
    mau: { value: 1, previous: null },
    avgDau: { value: 1, previous: null },
    stickiness: { value: 100, previous: null },
    newSignups: { value: 0, previous: null, suspected: 0 },
  },
  activeUsers: {
    days: [{ day: '2026-06-14', dau: null, wau: null, mau: null, partial: false }],
    bySource: [{ day: '2026-06-14', partial: false, counts: null }],
    sources: ['web'],
  },
  signups: { buckets: [], totals: { legit: 0, suspected: 0 }, bySignal: [] },
  usage: {
    features: ['chat', 'other'],
    days: [
      { day: '2026-06-14', partial: false, byFeature: null, credits: null },
      { day: '2026-06-15', partial: true, byFeature: { chat: 3, other: 1 }, credits: 12.5 },
    ],
    models: [{ model: 'gpt-4.1', requests: 3, share: 75 }],
    otherModelRequests: 1,
    totals: { requests: 4, credits: 12.5 },
    summaryDays: 5,
  },
} satisfies AnalyticsOverview;

const topAccounts: AnalyticsTopAccounts = {
  covered: { from: '2026-06-09', to: '2026-06-14' },
  missingDays: [],
  users: [
    {
      id: 'u1',
      name: '=HYPERLINK("x"), "Ada"',
      plan: 'PaidUser',
      activeDays: 4,
      requests: 3,
      credits: 9,
      share: 75,
      known: true,
    },
  ],
  orgs: [],
  excluded: { suspected: 0, suspended: 0 },
};

const fileNamed = (files: ReturnType<typeof buildAnalyticsCsvFiles>, name: string) => {
  const file = files.find(f => f.name === name);
  if (!file) throw new Error(`no ${name}`);
  return file.csv.replace(/^\uFEFF/, '').split('\r\n');
};

beforeEach(() => download.downloadData.mockReset());

describe('buildAnalyticsCsvFiles', () => {
  it('writes one file per section with units in the headers', () => {
    const files = buildAnalyticsCsvFiles(overview, topAccounts);
    expect(files.map(f => f.name)).toEqual([
      'active-users.csv',
      'requests-by-surface.csv',
      'signups.csv',
      'signup-signals.csv',
      'usage-by-feature.csv',
      'requests-by-model.csv',
      'credits-consumed.csv',
      'top-users.csv',
      'top-organizations.csv',
    ]);
    expect(files.every(f => f.csv.startsWith('\uFEFF'))).toBe(true);
    expect(fileNamed(files, 'usage-by-feature.csv')[0]).toBe(
      'Day (UTC),Partial day (today),Chat (AI requests),Other (AI requests)'
    );
  });

  it('leaves a missing rollup day empty rather than zero', () => {
    const rows = fileNamed(buildAnalyticsCsvFiles(overview, topAccounts), 'credits-consumed.csv');
    expect(rows.slice(1)).toEqual(['2026-06-14,no,', '2026-06-15,yes,12.5']);
  });

  it('adds the other-models row with its share', () => {
    const rows = fileNamed(buildAnalyticsCsvFiles(overview, topAccounts), 'requests-by-model.csv');
    expect(rows.slice(1)).toEqual(['gpt-4.1,3,75', 'Other models,1,25']);
  });

  it('quotes per RFC 4180 and defuses formula cells', () => {
    const rows = fileNamed(buildAnalyticsCsvFiles(overview, topAccounts), 'top-users.csv');
    expect(rows[1]).toBe(`1,u1,"'=HYPERLINK(""x""), ""Ada""",PaidUser,4,3,9,75`);
  });

  it('skips the top-account files until they have loaded', () => {
    expect(buildAnalyticsCsvFiles(overview, undefined).map(f => f.name)).not.toContain('top-users.csv');
  });
});

describe('downloadAnalyticsExport', () => {
  it('downloads every section in one zip named for the range', async () => {
    await downloadAnalyticsExport(overview, topAccounts);
    const [blob, name, type] = download.downloadData.mock.calls[0];
    expect(name).toBe('analytics_2026-06-09_2026-06-15_utc.zip');
    expect(type).toBe('application/zip');
    const zip = await JSZip.loadAsync(await (blob as Blob).arrayBuffer());
    expect(Object.keys(zip.files)).toHaveLength(9);
    expect(await zip.file('signups.csv')?.async('string')).toContain('Bucket start (UTC)');
  });
});

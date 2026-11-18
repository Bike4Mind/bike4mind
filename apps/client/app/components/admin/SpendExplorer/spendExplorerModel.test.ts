import { describe, it, expect } from 'vitest';
import type { SpendAccountsResponse, SpendTimelineBucket } from '@bike4mind/common';
import { readSpendExplorerSearch } from './spendExplorerSearch';
import {
  bucketForRange,
  buildSlackSummary,
  computeKpis,
  customRange,
  formatBucket,
  formatRange,
  presetRange,
} from './spendExplorerModel';

const bucket = (start: string, totalUsd: number, extra: Partial<SpendTimelineBucket> = {}): SpendTimelineBucket => ({
  start,
  totalUsd,
  series: {},
  baselineUsd: 10,
  isSpike: false,
  previousUsd: 0,
  ...extra,
});

const accounts: SpendAccountsResponse = {
  totalCostUsd: 100,
  byProvider: [],
  bySegment: [],
  accounts: [
    {
      accountId: 'a',
      payers: [],
      name: 'Acct A',
      segment: 'internal',
      costUsd: 50,
      share: 0.5,
      requests: 1,
      createdAt: null,
      newInTop10: false,
    },
    {
      accountId: 'b',
      payers: [],
      name: 'Acct B',
      segment: 'customer',
      costUsd: 20,
      share: 0.2,
      requests: 1,
      createdAt: null,
      newInTop10: true,
    },
  ] as SpendAccountsResponse['accounts'],
};

describe('ranges', () => {
  it('builds presets from whole UTC days, today included', () => {
    const range = presetRange(7, new Date('2026-11-17T15:00:00Z'));
    expect(range.from.toISOString()).toBe('2026-11-11T00:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-11-18T00:00:00.000Z');
    expect(formatRange(range)).toBe('Nov 11-17');
  });

  it('parses an inclusive custom range and rejects an inverted one', () => {
    const range = customRange('2026-10-28', '2026-11-03');
    expect(range && formatRange(range)).toBe('Oct 28-Nov 3');
    expect(customRange('2026-11-03', '2026-10-28')).toBeNull();
  });

  it('switches to hourly buckets at three days or less', () => {
    expect(bucketForRange(customRange('2026-11-01', '2026-11-03')!)).toBe('hour');
    expect(bucketForRange(customRange('2026-11-01', '2026-11-04')!)).toBe('day');
  });
});

describe('computeKpis', () => {
  it('derives total, median, peak and top-5 share', () => {
    const kpis = computeKpis(
      [bucket('2026-11-10T00:00:00Z', 10), bucket('2026-11-11T00:00:00Z', 30), bucket('2026-11-12T00:00:00Z', 20)],
      accounts
    );
    expect(kpis.totalUsd).toBe(60);
    expect(kpis.medianUsd).toBe(20);
    expect(kpis.peak?.start).toBe('2026-11-11T00:00:00Z');
    expect(kpis.top5Share).toBeCloseTo(0.7);
  });

  it('has no peak or share with no spend', () => {
    expect(computeKpis([bucket('2026-11-10T00:00:00Z', 0)], undefined)).toMatchObject({ peak: null, top5Share: null });
  });
});

describe('buildSlackSummary', () => {
  it('summarizes the view as plain text', () => {
    const text = buildSlackSummary({
      range: customRange('2026-11-10', '2026-11-11')!,
      bucket: 'day',
      buckets: [bucket('2026-11-10T00:00:00Z', 10), bucket('2026-11-11T00:00:00Z', 17, { isSpike: true })],
      accounts,
    });
    expect(text).toBe(
      'Nov 10-11 (UTC): B4M recorded $27.00 of AI provider cost; peak Nov 11 $17.00 (1.7x median); 1 spike day; top spenders: Acct A $50.00 (50%), Acct B $20.00 (20%).'
    );
    expect(text).toMatch(/^[\x20-\x7e]+$/);
  });

  it('formats hour buckets with the UTC hour', () => {
    expect(formatBucket('2026-11-11T14:00:00Z', 'hour')).toBe('Nov 11 14:00');
  });
});

describe('readSpendExplorerSearch', () => {
  const now = new Date('2026-11-18T12:00:00Z');

  it('reads the values TanStack Router hands back after JSON-parsing the URL', () => {
    const view = readSpendExplorerSearch({ spendRange: 30, spendPrevious: true, spendSplit: 'model' }, now);
    expect(view.preset).toBe(30);
    expect(view.showPrevious).toBe(true);
    expect(view.split).toBe('model');
  });

  it('falls back to the defaults for malformed values', () => {
    const view = readSpendExplorerSearch({ spendRange: 11, spendSplit: 'colour', spendAt: 'nope' }, now);
    expect(view.preset).toBe(14);
    expect(view.split).toBe('provider');
    expect(view.at).toBeNull();
  });
});

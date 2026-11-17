import { afterEach, describe, it, expect, vi } from 'vitest';
import { parseQaFilters } from './filters';
import { rangeInstants, resolveRange, spanDays } from '../../app/components/QaStatus/dateRange';

afterEach(() => {
  vi.unstubAllEnvs();
});

const NOW = new Date('2026-11-13T12:00:00.000Z');
const daysBefore = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('parseQaFilters', () => {
  it('defaults branch to main and the range to the last 7 days, and drops empty selects', () => {
    expect(parseQaFilters({ product: 'product-a', tenant: '', env: '' }, NOW)).toEqual({
      product: 'product-a',
      branch: 'main',
      from: daysBefore(7),
      to: NOW,
    });
  });

  it('reads every filter, with from/to taking over from range', () => {
    expect(
      parseQaFilters(
        {
          product: 'product-a',
          tenant: 'tenant-a',
          env: 'staging',
          branch: 'feat/x',
          range: '30d',
          from: '2026-11-01T00:00:00.000+08:00',
          to: '2026-11-14T00:00:00.000+08:00',
        },
        NOW
      )
    ).toEqual({
      product: 'product-a',
      tenant: 'tenant-a',
      env: 'staging',
      branch: 'feat/x',
      from: new Date('2026-10-31T16:00:00.000Z'),
      to: new Date('2026-11-13T16:00:00.000Z'),
    });
  });

  it('still reads the older 30d range', () => {
    expect(parseQaFilters({ product: 'product-a', range: '30d' }, NOW)).toMatchObject({
      from: daysBefore(30),
      to: NOW,
    });
  });

  it.each([
    ['UTC', '2024-11-02', '2025-11-02', '2024-11-02T00:00:00.000Z', '2025-11-03T00:00:00.000Z'],
    ['America/New_York', '2024-11-02', '2025-11-02', '2024-11-02T04:00:00.000Z', '2025-11-03T05:00:00.000Z'],
    ['Australia/Lord_Howe', '2024-04-06', '2025-04-06', '2024-04-05T13:00:00.000Z', '2025-04-06T13:30:00.000Z'],
    ['America/New_York', '2025-03-08', '2026-03-08', '2025-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
  ])('accepts the UI maximum local-day range in %s starting %s', (timezone, from, to, instantFrom, instantTo) => {
    vi.stubEnv('TZ', timezone);
    const range = resolveRange({ from, to });
    expect(spanDays(range)).toBe(366);
    const bounds = rangeInstants(range);
    expect(bounds).toEqual({ from: instantFrom, to: instantTo });
    expect(parseQaFilters({ product: 'product-a', ...bounds })).toMatchObject({
      from: new Date(bounds.from),
      to: new Date(bounds.to),
    });
  });

  it('rejects 367 whole elapsed days even with the offset-transition allowance', () => {
    const from = new Date('2024-01-01T00:00:00.000Z');
    const to = new Date(from.getTime() + 367 * 86_400_000);
    expect(() => parseQaFilters({ product: 'product-a', from: from.toISOString(), to: to.toISOString() })).toThrow(
      'at most 366 days'
    );
  });

  it('rejects a missing product, an unknown range and a bad date range', () => {
    expect(() => parseQaFilters({})).toThrow();
    expect(() => parseQaFilters({ product: 'product-a', range: '90d' })).toThrow();
    expect(() => parseQaFilters({ product: 'product-a', from: '2026-11-01T00:00:00Z' })).toThrow();
    expect(() => parseQaFilters({ product: 'product-a', from: 'yesterday', to: '2026-11-02T00:00:00Z' })).toThrow();
    expect(() =>
      parseQaFilters({ product: 'product-a', from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' })
    ).toThrow();
    expect(() =>
      parseQaFilters({ product: 'product-a', from: '2025-01-01T00:00:00Z', to: '2026-11-01T00:00:00Z' })
    ).toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import { parseQaFilters } from './filters';

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

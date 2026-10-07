import { describe, it, expect } from 'vitest';
import { parseQaFilters } from './filters';

describe('parseQaFilters', () => {
  it('defaults branch to main and range to 7 days, and drops empty selects', () => {
    expect(parseQaFilters({ product: 'product-a', tenant: '', env: '' })).toEqual({
      product: 'product-a',
      branch: 'main',
      rangeDays: 7,
    });
  });
  it('reads every filter', () => {
    expect(
      parseQaFilters({ product: 'product-a', tenant: 'tenant-a', env: 'staging', branch: 'feat/x', range: '30d' })
    ).toEqual({
      product: 'product-a',
      tenant: 'tenant-a',
      env: 'staging',
      branch: 'feat/x',
      rangeDays: 30,
    });
  });
  it('rejects a missing product and an unknown range', () => {
    expect(() => parseQaFilters({})).toThrow();
    expect(() => parseQaFilters({ product: 'product-a', range: '90d' })).toThrow();
  });
});

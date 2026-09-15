import { describe, it, expect } from 'vitest';
import { computeStoragePercent } from '../storageUtils';

describe('computeStoragePercent', () => {
  it('returns 0 when storageLimit is 0 (prevents NaN from 0/0)', () => {
    expect(computeStoragePercent(0, 0)).toBe(0);
  });

  it('returns 0 when storageLimit is negative', () => {
    expect(computeStoragePercent(100, -1)).toBe(0);
  });

  it('returns 0 when currentStorageSize is 0 and limit is non-zero', () => {
    expect(computeStoragePercent(0, 100)).toBe(0);
  });

  it('returns 100 when usage equals the full limit', () => {
    const limitMb = 100;
    const limitBytes = limitMb * 1024 * 1024;
    expect(computeStoragePercent(limitBytes, limitMb)).toBe(100);
  });

  it('returns 50 when usage is half the limit', () => {
    const limitMb = 200;
    const limitBytes = limitMb * 1024 * 1024;
    expect(computeStoragePercent(limitBytes / 2, limitMb)).toBe(50);
  });

  it('can exceed 100 when usage is over the allocated limit', () => {
    const limitMb = 10;
    const limitBytes = limitMb * 1024 * 1024;
    expect(computeStoragePercent(limitBytes * 2, limitMb)).toBe(200);
  });
});

import { describe, it, expect } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import { storageLimitToBytes } from '@bike4mind/common';
import { checkStorageLimit } from '@bike4mind/utils';
import { getStorageQuota } from '@client/app/utils/storageQuota';
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
    expect(computeStoragePercent(100_000_000, 100)).toBe(100);
  });

  it('returns 50 when usage is half the limit', () => {
    expect(computeStoragePercent(100_000_000, 200)).toBe(50);
  });

  it('can exceed 100 when usage is over the allocated limit', () => {
    expect(computeStoragePercent(20_000_000, 10)).toBe(200);
  });

  // The limit is decimal MB, as enforcement reads it: 920,000,000 bytes of a 1000 MB limit is 92%.
  it('reads the limit as decimal MB, matching enforcement', () => {
    expect(computeStoragePercent(920_000_000, 1000)).toBe(92);
  });

  it.each([1, 1000, 5000])('reads a user at exactly a %i MB limit as full', limitMb => {
    expect(computeStoragePercent(1_000_000 * limitMb, limitMb)).toBe(100);
  });
});

describe('storage limit parity across admin, user UI and enforcement', () => {
  const user = (fields: Partial<IUserDocument>) => fields as IUserDocument;

  it.each([1, 1000, 5000])('agrees on the byte limit for %i MB', async limitMb => {
    const limitBytes = getStorageQuota({ storageLimit: limitMb, currentStorageSize: 0 })!.limitBytes;

    expect(limitBytes).toBe(1_000_000 * limitMb);
    expect(storageLimitToBytes(limitMb)).toBe(limitBytes);
    expect(computeStoragePercent(limitBytes, limitMb)).toBe(100);
    await expect(checkStorageLimit(user({ storageLimit: limitMb, currentStorageSize: limitBytes }), 0)).resolves.toBe(
      undefined
    );
    await expect(checkStorageLimit(user({ storageLimit: limitMb, currentStorageSize: limitBytes }), 1)).rejects.toThrow(
      'File size exceeds storage limit'
    );
  });
});

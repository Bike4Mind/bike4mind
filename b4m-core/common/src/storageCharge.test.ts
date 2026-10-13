import { describe, expect, it } from 'vitest';
import { chargedBytes, isStorageCharged, STORAGE_CHARGE_STAMP_CUTOFF } from './storageCharge';

const before = new Date(STORAGE_CHARGE_STAMP_CUTOFF.getTime() - 1);
const after = new Date(STORAGE_CHARGE_STAMP_CUTOFF.getTime() + 1);

describe('isStorageCharged / chargedBytes', () => {
  it('counts a stamped row whatever its status (notebook import stamps pending rows)', () => {
    expect(chargedBytes({ storageChargedAt: after, status: 'pending', createdAt: after, fileSize: 10 })).toBe(10);
    expect(chargedBytes({ storageChargedAt: after, createdAt: after, fileSize: 10 })).toBe(10);
  });

  it('does not count an unstamped pending row', () => {
    expect(chargedBytes({ status: 'pending', createdAt: before, fileSize: 10 })).toBe(0);
    expect(chargedBytes({ storageChargedAt: null, status: 'pending', createdAt: after, fileSize: 10 })).toBe(0);
  });

  it('counts a legacy unstamped complete row from before the cutoff', () => {
    expect(chargedBytes({ status: 'complete', createdAt: before, fileSize: 10 })).toBe(10);
    expect(chargedBytes({ status: 'complete', createdAt: before.toISOString(), fileSize: 10 })).toBe(10);
  });

  it('does not count an unstamped complete row from after the cutoff', () => {
    expect(chargedBytes({ status: 'complete', createdAt: after, fileSize: 10 })).toBe(0);
    expect(chargedBytes({ status: 'complete', createdAt: STORAGE_CHARGE_STAMP_CUTOFF, fileSize: 10 })).toBe(0);
  });

  it('treats a missing createdAt as not legacy and a missing fileSize as 0', () => {
    expect(isStorageCharged({ status: 'complete' })).toBe(false);
    expect(chargedBytes({ storageChargedAt: after })).toBe(0);
  });
});

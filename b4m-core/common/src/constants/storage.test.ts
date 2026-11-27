import { describe, it, expect } from 'vitest';
import {
  resolveOrganizationStorageLimit,
  organizationStorageLimitBytes,
  resolveUserStorageLimit,
  storageLimitToBytes,
} from './storage';

describe('resolveOrganizationStorageLimit', () => {
  it.each([
    [{}, 10_000, 'default'],
    [{ storageLimit: null }, 10_000, 'default'],
    [{ storageLimit: 10_000 }, 10_000, 'override'],
    [{ storageLimit: 2500 }, 2500, 'override'],
    [{ storageLimit: 0 }, 0, 'override'],
    [{ storageLimitOverride: null, planStorageLimit: 5000 }, 5000, 'plan'],
    [{ storageLimit: 2500, storageLimitOverride: null }, 10_000, 'default'],
    [{ storageLimit: 2500, planStorageLimit: 5000 }, 5000, 'plan'],
    [{ storageLimitOverride: 0, planStorageLimit: 5000 }, 0, 'override'],
    [{ storageLimitOverride: 2000, planStorageLimit: 5000 }, 2000, 'override'],
  ])('resolves %j to %i MB from %s', (allocation, limitMb, source) => {
    expect(resolveOrganizationStorageLimit(allocation)).toEqual({ limitMb, source });
    expect(organizationStorageLimitBytes(allocation)).toBe(storageLimitToBytes(limitMb));
  });
});

describe('storageLimitToBytes', () => {
  it('converts decimal MB to bytes', () => {
    expect(storageLimitToBytes(1000)).toBe(1_000_000_000);
    expect(storageLimitToBytes(0)).toBe(0);
  });
});

describe('resolveUserStorageLimit', () => {
  it.each([
    [{}, 1000, 'default'],
    [{ storageLimitOverride: null, planStorageLimit: null }, 1000, 'default'],
    [{ planStorageLimit: 5000 }, 5000, 'plan'],
    [{ storageLimitOverride: 2000, planStorageLimit: 5000 }, 2000, 'override'],
    [{ storageLimitOverride: 0, planStorageLimit: 5000 }, 0, 'override'],
    [{ planStorageLimit: 0 }, 0, 'plan'],
    [{ storageLimit: 2500 }, 2500, 'override'],
    [{ storageLimit: 1000 }, 1000, 'default'],
    [{ storageLimit: 2500, storageLimitOverride: null }, 1000, 'default'],
    [{ storageLimit: 2500, storageLimitOverride: null, planStorageLimit: 5000 }, 5000, 'plan'],
  ])('resolves %j to %i MB from %s', (allocation, limitMb, source) => {
    expect(resolveUserStorageLimit(allocation)).toEqual({ limitMb, source });
  });
});

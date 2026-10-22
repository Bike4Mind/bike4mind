import { describe, it, expect } from 'vitest';
import { storageLimitToBytes } from './storage';

describe('storageLimitToBytes', () => {
  it('converts decimal MB to bytes', () => {
    expect(storageLimitToBytes(1000)).toBe(1_000_000_000);
    expect(storageLimitToBytes(0)).toBe(0);
  });
});

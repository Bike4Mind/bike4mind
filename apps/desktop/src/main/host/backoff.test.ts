import { describe, expect, it } from 'vitest';
import { backoffDelay } from './backoff';

const policy = { baseMs: 1_000, capMs: 60_000 };

describe('backoffDelay', () => {
  it('doubles from the base up to the cap', () => {
    const ceilings = [1, 2, 3, 4, 5, 6, 7, 8, 100].map(attempt => backoffDelay(attempt, policy, () => 1));
    expect(ceilings).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  it('jitters within the upper half of the ceiling', () => {
    expect(backoffDelay(3, policy, () => 0)).toBe(2_000);
    expect(backoffDelay(3, policy, () => 0.5)).toBe(3_000);
    expect(backoffDelay(3, policy, () => 1)).toBe(4_000);
  });
});

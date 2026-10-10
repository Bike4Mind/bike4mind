import { describe, expect, it } from 'vitest';
import { isValidDim, MAX_MAP_DIM, MIN_MAP_DIM } from './TavernMapModel';

describe('isValidDim', () => {
  it('uses 160 as the maximum', () => {
    expect(MAX_MAP_DIM).toBe(160);
  });

  it('accepts the bounds', () => {
    expect(isValidDim(MIN_MAP_DIM)).toBe(true);
    expect(isValidDim(160)).toBe(true);
  });

  it('rejects out-of-range and non-integer values', () => {
    expect(isValidDim(161)).toBe(false);
    expect(isValidDim(MIN_MAP_DIM - 1)).toBe(false);
    expect(isValidDim(10.5)).toBe(false);
    expect(isValidDim('10')).toBe(false);
  });
});

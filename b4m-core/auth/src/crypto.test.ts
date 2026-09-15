import { safeCompareTokens } from './crypto';

describe('safeCompareTokens', () => {
  it('returns true for equal strings', () => {
    expect(safeCompareTokens('abc123', 'abc123')).toBe(true);
  });

  it('returns false for different lengths', () => {
    expect(safeCompareTokens('abc', 'abcd')).toBe(false);
  });

  it('returns false for same length different content', () => {
    expect(safeCompareTokens('abc', 'xyz')).toBe(false);
  });

  it('returns false for empty strings', () => {
    expect(safeCompareTokens('', '')).toBe(false);
  });

  it('returns false for one empty one non-empty', () => {
    expect(safeCompareTokens('', 'abc')).toBe(false);
    expect(safeCompareTokens('abc', '')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { capForParse, DEFAULT_PARSE_CAP } from './capForParse';

describe('capForParse', () => {
  // NaN fails every comparison, so without a finite check this returned '' - and a caller
  // that re-appends the uncapped tail then scrubs nothing at all, failing open.
  it.each([[NaN], [Infinity], [-Infinity]])('rejects a non-finite max: %s', max => {
    expect(() => capForParse('abc', max)).toThrow(RangeError);
  });

  it('returns short input unchanged', () => {
    const input = 'hello world';
    expect(capForParse(input, 100)).toBe(input);
  });

  it('returns input unchanged when exactly at the cap', () => {
    const input = 'x'.repeat(50);
    expect(capForParse(input, 50)).toBe(input);
  });

  it('truncates to the first `max` characters when over the cap', () => {
    const input = 'x'.repeat(101);
    const out = capForParse(input, 50);
    expect(out).toHaveLength(50);
    expect(out).toBe('x'.repeat(50));
  });

  it('bounds an adversarial input to a fixed length regardless of its size', () => {
    const adversarial = '('.repeat(1_000_000);
    expect(capForParse(adversarial, 1000)).toHaveLength(1000);
  });

  it('applies DEFAULT_PARSE_CAP when no max is given', () => {
    const input = 'a'.repeat(DEFAULT_PARSE_CAP + 10);
    expect(capForParse(input)).toHaveLength(DEFAULT_PARSE_CAP);
    const small = 'a'.repeat(DEFAULT_PARSE_CAP - 10);
    expect(capForParse(small)).toBe(small);
  });

  it('handles the empty string', () => {
    expect(capForParse('', 100)).toBe('');
  });

  it('rejects a negative max (programmer error, fail loud)', () => {
    expect(() => capForParse('x', -1)).toThrow(RangeError);
  });
});

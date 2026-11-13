import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_FIX_ATTEMPTS, parseAutoFixAttempts } from './autoFixSetting';

describe('parseAutoFixAttempts', () => {
  it.each([1, 2, 5, 20])('keeps %d', value => {
    expect(parseAutoFixAttempts(value)).toBe(value);
  });

  it.each([undefined, null, '3', 0, -1, 21, 2.5, Number.NaN, Infinity])('reads %s as the default', value => {
    expect(parseAutoFixAttempts(value)).toBe(DEFAULT_AUTO_FIX_ATTEMPTS);
  });
});

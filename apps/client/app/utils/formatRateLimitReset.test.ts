import { describe, it, expect } from 'vitest';
import { formatRateLimitReset } from './formatRateLimitReset';

describe('formatRateLimitReset', () => {
  const nowMs = 1_700_000_000_000;
  const nowSeconds = Math.floor(nowMs / 1000);

  it('formats hours and minutes', () => {
    expect(formatRateLimitReset(nowSeconds + 3 * 3600 + 12 * 60, nowMs)).toBe('3h 12m');
  });

  it('formats minutes and seconds', () => {
    expect(formatRateLimitReset(nowSeconds + 45 * 60, nowMs)).toBe('45m');
    expect(formatRateLimitReset(nowSeconds + 30, nowMs)).toBe('30s');
  });

  it('is empty when absent or already past', () => {
    expect(formatRateLimitReset(undefined, nowMs)).toBe('');
    expect(formatRateLimitReset(0, nowMs)).toBe('');
    expect(formatRateLimitReset(nowSeconds - 1, nowMs)).toBe('');
  });
});

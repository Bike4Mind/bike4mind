import { describe, expect, it } from 'vitest';
import { formatDuration, formatExpiresIn, getDlqExpiry } from './dlqExpiry';

const HOUR = 3600 * 1000;
const NOW = 1_700_000_000_000;

describe('getDlqExpiry', () => {
  it('returns null without a usable sent timestamp', () => {
    expect(getDlqExpiry(undefined, 345600, NOW)).toBeNull();
    expect(getDlqExpiry('abc', 345600, NOW)).toBeNull();
  });

  it('computes age and remaining time from retention', () => {
    const result = getDlqExpiry(String(NOW - 10 * HOUR), 4 * 24 * 3600, NOW);
    expect(result).toEqual({ ageMs: 10 * HOUR, remainingMs: 86 * HOUR, warn: false });
  });

  it('shows different expiry for queues with different retention', () => {
    const sent = String(NOW - 10 * HOUR);
    expect(getDlqExpiry(sent, 4 * 24 * 3600, NOW)?.remainingMs).toBe(86 * HOUR);
    expect(getDlqExpiry(sent, 14 * 24 * 3600, NOW)?.remainingMs).toBe(326 * HOUR);
  });

  it('warns when under 24 hours remain, not at exactly 24 hours', () => {
    expect(getDlqExpiry(String(NOW - 73 * HOUR), 4 * 24 * 3600, NOW)?.warn).toBe(true);
    expect(getDlqExpiry(String(NOW - 72 * HOUR), 4 * 24 * 3600, NOW)?.warn).toBe(false);
  });

  it('clamps an already-expired message to zero and warns', () => {
    expect(getDlqExpiry(String(NOW - 200 * HOUR), 4 * 24 * 3600, NOW)).toMatchObject({ remainingMs: 0, warn: true });
  });

  it('leaves expiry unknown when retention is missing', () => {
    expect(getDlqExpiry(String(NOW - HOUR), undefined, NOW)).toEqual({ ageMs: HOUR, remainingMs: null, warn: false });
  });
});

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(30 * 1000)).toBe('<1m');
    expect(formatDuration(45 * 60 * 1000)).toBe('45m');
    expect(formatDuration(5 * HOUR + 7 * 60 * 1000)).toBe('5h 7m');
    expect(formatDuration(50 * HOUR)).toBe('2d 2h');
  });

  it('formats expires-in states', () => {
    expect(formatExpiresIn({ ageMs: 0, remainingMs: null, warn: false })).toBe('N/A');
    expect(formatExpiresIn({ ageMs: 0, remainingMs: 0, warn: true })).toBe('Expired');
    expect(formatExpiresIn({ ageMs: 0, remainingMs: 3 * HOUR, warn: true })).toBe('3h 0m');
  });
});

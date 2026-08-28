import { describe, it, expect } from 'vitest';
import { formatAccountAge, formatAccountCreatedTitle } from './formatAccountAge';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatAccountAge', () => {
  it('scales through the units', () => {
    expect(formatAccountAge(ago(30_000), NOW)).toBe('just now');
    expect(formatAccountAge(ago(5 * MIN), NOW)).toBe('5m ago');
    expect(formatAccountAge(ago(3 * HOUR), NOW)).toBe('3h ago');
    expect(formatAccountAge(ago(3 * DAY), NOW)).toBe('3d ago');
    expect(formatAccountAge(ago(60 * DAY), NOW)).toBe('2mo ago');
    expect(formatAccountAge(ago(400 * DAY), NOW)).toBe('1y ago');
  });

  it('does not render a negative age for a future or clock-skewed date', () => {
    expect(formatAccountAge(new Date(NOW.getTime() + DAY).toISOString(), NOW)).toBe('today');
  });

  it('returns null rather than a placeholder when the field is absent or junk', () => {
    // Every user has timestamps, so absent means a projection dropped it -
    // rendering an epoch date would look like real data.
    expect(formatAccountAge(undefined, NOW)).toBeNull();
    expect(formatAccountAge(null, NOW)).toBeNull();
    expect(formatAccountAge('', NOW)).toBeNull();
    expect(formatAccountAge('not a date', NOW)).toBeNull();
  });

  it('accepts a Date as well as an ISO string', () => {
    expect(formatAccountAge(new Date(NOW.getTime() - 2 * DAY), NOW)).toBe('2d ago');
  });
});

describe('formatAccountCreatedTitle', () => {
  it('gives a full timestamp for the hover', () => {
    expect(formatAccountCreatedTitle('2026-08-24T00:00:00.000Z')).toContain('Account created');
  });

  it('is null when there is nothing to show', () => {
    expect(formatAccountCreatedTitle(undefined)).toBeNull();
    expect(formatAccountCreatedTitle('nope')).toBeNull();
  });
});

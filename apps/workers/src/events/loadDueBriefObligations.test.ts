import { describe, expect, it } from 'vitest';
import { addDays, calendarDayIn } from './loadDueBriefObligations';

describe('loadDueBriefObligations day math', () => {
  it('reads today in the brief time zone, not UTC', () => {
    const lateUtc = new Date('2026-11-25T23:30:00Z');
    expect(calendarDayIn(lateUtc, 'UTC')).toBe('2026-11-25');
    expect(calendarDayIn(lateUtc, 'Asia/Tokyo')).toBe('2026-11-26');
    expect(calendarDayIn(new Date('2026-11-25T03:00:00Z'), 'America/Los_Angeles')).toBe('2026-11-24');
  });

  it('falls back to UTC for a missing or unknown zone', () => {
    const at = new Date('2026-11-25T23:30:00Z');
    expect(calendarDayIn(at, undefined)).toBe('2026-11-25');
    expect(calendarDayIn(at, 'Not/AZone')).toBe('2026-11-25');
  });

  it('adds the lead window across a month boundary', () => {
    expect(addDays('2026-11-28', 7)).toBe('2026-12-05');
  });
});

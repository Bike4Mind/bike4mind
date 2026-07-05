import { describe, it, expect } from 'vitest';
import {
  getRunHoursForInterval,
  getNextScheduledRun,
  shouldRunAtCurrentHour,
  getIntervalDescription,
} from './liveopsScheduleUtils';

describe('liveopsScheduleUtils', () => {
  describe('getRunHoursForInterval', () => {
    it('returns correct hours for 6-hour interval', () => {
      expect(getRunHoursForInterval(6)).toEqual([2, 8, 14, 20]);
    });

    it('returns correct hours for 12-hour interval', () => {
      expect(getRunHoursForInterval(12)).toEqual([2, 14]);
    });

    it('returns correct hours for 24-hour interval', () => {
      expect(getRunHoursForInterval(24)).toEqual([14]);
    });

    it('defaults to 24-hour schedule for unknown intervals', () => {
      expect(getRunHoursForInterval(8)).toEqual([14]);
      expect(getRunHoursForInterval(0)).toEqual([14]);
      expect(getRunHoursForInterval(-1)).toEqual([14]);
    });
  });

  describe('getNextScheduledRun', () => {
    describe('with 12-hour interval', () => {
      it('returns same day 14:00 UTC when current time is before 14:00', () => {
        // 10:00 UTC -> next run at 14:00 UTC same day
        const reference = new Date('2024-02-22T10:00:00Z');
        const result = getNextScheduledRun(12, reference);
        expect(result.getUTCHours()).toBe(14);
        expect(result.getUTCDate()).toBe(22);
      });

      it('returns same day 14:00 UTC when current time is 02:00 (after first slot)', () => {
        // 02:30 UTC -> next run at 14:00 UTC same day
        const reference = new Date('2024-02-22T02:30:00Z');
        const result = getNextScheduledRun(12, reference);
        expect(result.getUTCHours()).toBe(14);
        expect(result.getUTCDate()).toBe(22);
      });

      it('returns next day 02:00 UTC when current time is after 14:00', () => {
        // 15:00 UTC -> next run at 02:00 UTC next day
        const reference = new Date('2024-02-22T15:00:00Z');
        const result = getNextScheduledRun(12, reference);
        expect(result.getUTCHours()).toBe(2);
        expect(result.getUTCDate()).toBe(23);
      });

      it('returns next day 02:00 UTC when current time is exactly 14:00', () => {
        // 14:00 UTC -> next run at 02:00 UTC next day (current slot has passed)
        const reference = new Date('2024-02-22T14:00:00Z');
        const result = getNextScheduledRun(12, reference);
        expect(result.getUTCHours()).toBe(2);
        expect(result.getUTCDate()).toBe(23);
      });

      it('returns same day 02:00 UTC when current time is 01:00', () => {
        // 01:00 UTC -> next run at 02:00 UTC same day
        const reference = new Date('2024-02-22T01:00:00Z');
        const result = getNextScheduledRun(12, reference);
        expect(result.getUTCHours()).toBe(2);
        expect(result.getUTCDate()).toBe(22);
      });
    });

    describe('with 6-hour interval', () => {
      it('returns next slot on same day', () => {
        // 09:00 UTC -> next run at 14:00 UTC same day
        const reference = new Date('2024-02-22T09:00:00Z');
        const result = getNextScheduledRun(6, reference);
        expect(result.getUTCHours()).toBe(14);
        expect(result.getUTCDate()).toBe(22);
      });

      it('wraps to next day after last slot', () => {
        // 21:00 UTC -> next run at 02:00 UTC next day
        const reference = new Date('2024-02-22T21:00:00Z');
        const result = getNextScheduledRun(6, reference);
        expect(result.getUTCHours()).toBe(2);
        expect(result.getUTCDate()).toBe(23);
      });

      it('finds correct slot mid-day', () => {
        // 03:00 UTC -> next run at 08:00 UTC same day
        const reference = new Date('2024-02-22T03:00:00Z');
        const result = getNextScheduledRun(6, reference);
        expect(result.getUTCHours()).toBe(8);
        expect(result.getUTCDate()).toBe(22);
      });
    });

    describe('with 24-hour interval', () => {
      it('returns same day 14:00 when before 14:00', () => {
        const reference = new Date('2024-02-22T08:00:00Z');
        const result = getNextScheduledRun(24, reference);
        expect(result.getUTCHours()).toBe(14);
        expect(result.getUTCDate()).toBe(22);
      });

      it('returns next day 14:00 when after 14:00', () => {
        const reference = new Date('2024-02-22T18:00:00Z');
        const result = getNextScheduledRun(24, reference);
        expect(result.getUTCHours()).toBe(14);
        expect(result.getUTCDate()).toBe(23);
      });
    });

    describe('edge cases', () => {
      it('handles month rollover', () => {
        // Last day of month, after last slot -> next day is new month
        const reference = new Date('2024-02-29T23:00:00Z'); // Leap year
        const result = getNextScheduledRun(12, reference);
        expect(result.getUTCMonth()).toBe(2); // March (0-indexed)
        expect(result.getUTCDate()).toBe(1);
      });

      it('handles year rollover', () => {
        const reference = new Date('2024-12-31T23:00:00Z');
        const result = getNextScheduledRun(12, reference);
        expect(result.getUTCFullYear()).toBe(2025);
        expect(result.getUTCMonth()).toBe(0); // January
        expect(result.getUTCDate()).toBe(1);
      });

      it('uses default interval when not provided', () => {
        const reference = new Date('2024-02-22T10:00:00Z');
        const result = getNextScheduledRun(undefined, reference);
        // Default is 12 hours, so should behave like 12-hour interval
        expect(result.getUTCHours()).toBe(14);
      });

      it('zeroes out minutes and seconds', () => {
        const reference = new Date('2024-02-22T10:45:30.123Z');
        const result = getNextScheduledRun(12, reference);
        expect(result.getUTCMinutes()).toBe(0);
        expect(result.getUTCSeconds()).toBe(0);
        expect(result.getUTCMilliseconds()).toBe(0);
      });
    });
  });

  describe('shouldRunAtCurrentHour', () => {
    describe('with 12-hour interval', () => {
      it('returns true at 02:00 UTC', () => {
        const reference = new Date('2024-02-22T02:30:00Z');
        expect(shouldRunAtCurrentHour(12, reference)).toBe(true);
      });

      it('returns true at 14:00 UTC', () => {
        const reference = new Date('2024-02-22T14:45:00Z');
        expect(shouldRunAtCurrentHour(12, reference)).toBe(true);
      });

      it('returns false at 08:00 UTC', () => {
        const reference = new Date('2024-02-22T08:00:00Z');
        expect(shouldRunAtCurrentHour(12, reference)).toBe(false);
      });

      it('returns false at 20:00 UTC', () => {
        const reference = new Date('2024-02-22T20:00:00Z');
        expect(shouldRunAtCurrentHour(12, reference)).toBe(false);
      });
    });

    describe('with 6-hour interval', () => {
      it('returns true at all scheduled hours', () => {
        expect(shouldRunAtCurrentHour(6, new Date('2024-02-22T02:00:00Z'))).toBe(true);
        expect(shouldRunAtCurrentHour(6, new Date('2024-02-22T08:00:00Z'))).toBe(true);
        expect(shouldRunAtCurrentHour(6, new Date('2024-02-22T14:00:00Z'))).toBe(true);
        expect(shouldRunAtCurrentHour(6, new Date('2024-02-22T20:00:00Z'))).toBe(true);
      });

      it('returns false at non-scheduled hours', () => {
        expect(shouldRunAtCurrentHour(6, new Date('2024-02-22T00:00:00Z'))).toBe(false);
        expect(shouldRunAtCurrentHour(6, new Date('2024-02-22T05:00:00Z'))).toBe(false);
        expect(shouldRunAtCurrentHour(6, new Date('2024-02-22T10:00:00Z'))).toBe(false);
        expect(shouldRunAtCurrentHour(6, new Date('2024-02-22T16:00:00Z'))).toBe(false);
      });
    });

    describe('with 24-hour interval', () => {
      it('returns true only at 14:00 UTC', () => {
        expect(shouldRunAtCurrentHour(24, new Date('2024-02-22T14:00:00Z'))).toBe(true);
      });

      it('returns false at other hours', () => {
        expect(shouldRunAtCurrentHour(24, new Date('2024-02-22T02:00:00Z'))).toBe(false);
        expect(shouldRunAtCurrentHour(24, new Date('2024-02-22T08:00:00Z'))).toBe(false);
        expect(shouldRunAtCurrentHour(24, new Date('2024-02-22T20:00:00Z'))).toBe(false);
      });
    });
  });

  describe('getIntervalDescription', () => {
    it('returns correct description for 6-hour interval', () => {
      expect(getIntervalDescription(6)).toBe('Runs at 2am, 8am, 2pm, 8pm CST');
    });

    it('returns correct description for 12-hour interval', () => {
      expect(getIntervalDescription(12)).toBe('Runs at 8am, 8pm CST (10am, 10pm PHT)');
    });

    it('returns correct description for 24-hour interval', () => {
      expect(getIntervalDescription(24)).toBe('Runs daily at 8am CST (10pm PHT)');
    });

    it('returns empty string for unknown intervals', () => {
      expect(getIntervalDescription(8)).toBe('');
      expect(getIntervalDescription(0)).toBe('');
    });
  });
});

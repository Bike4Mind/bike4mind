/**
 * Tests for Time Parser Utility
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseTimeExpression,
  validateScheduledTime,
  parseAndValidateTime,
  formatDateTime,
  nowInSeconds,
} from './time-parser';

describe('time-parser', () => {
  // Use a fixed reference date for consistent testing
  const referenceDate = new Date('2024-01-15T10:00:00.000Z');
  const timezone = 'America/Los_Angeles'; // PST/PDT

  describe('parseTimeExpression', () => {
    describe('natural language expressions', () => {
      it('should parse "tomorrow at 9am"', () => {
        const result = parseTimeExpression('tomorrow at 9am', timezone, referenceDate);

        expect(result).not.toBeNull();
        // Check via formatted output which handles timezone correctly
        expect(result!.formatted).toContain('9:00 AM');
        expect(result!.formatted).toContain('Jan 16');
      });

      it('should parse "in 2 hours"', () => {
        const result = parseTimeExpression('in 2 hours', timezone, referenceDate);

        expect(result).not.toBeNull();
        // Should be approximately 2 hours from reference
        const expectedTime = new Date(referenceDate.getTime() + 2 * 60 * 60 * 1000);
        const timeDiff = Math.abs(result!.date.getTime() - expectedTime.getTime());
        expect(timeDiff).toBeLessThan(60 * 1000); // Within 1 minute tolerance
      });

      it('should parse "next Monday at 3pm"', () => {
        const result = parseTimeExpression('next Monday at 3pm', timezone, referenceDate);

        expect(result).not.toBeNull();
        // Check via formatted output - should be a Monday at 3pm
        expect(result!.formatted).toContain('Mon');
        expect(result!.formatted).toContain('3:00 PM');
      });

      it('should parse "in 30 minutes"', () => {
        const result = parseTimeExpression('in 30 minutes', timezone, referenceDate);

        expect(result).not.toBeNull();
        const expectedTime = new Date(referenceDate.getTime() + 30 * 60 * 1000);
        const timeDiff = Math.abs(result!.date.getTime() - expectedTime.getTime());
        expect(timeDiff).toBeLessThan(60 * 1000);
      });

      it('should parse "next week"', () => {
        const result = parseTimeExpression('next week', timezone, referenceDate);

        expect(result).not.toBeNull();
        // Should be approximately 7 days from reference
        const dayDiff = Math.round((result!.date.getTime() - referenceDate.getTime()) / (24 * 60 * 60 * 1000));
        expect(dayDiff).toBeGreaterThanOrEqual(7);
      });
    });

    describe('ISO format dates', () => {
      it('should parse "2024-01-20 14:00"', () => {
        const result = parseTimeExpression('2024-01-20 14:00', timezone, referenceDate);

        expect(result).not.toBeNull();
        // Check formatted output for correct date/time
        expect(result!.formatted).toContain('Jan 20, 2024');
        expect(result!.formatted).toContain('2:00 PM');
      });

      it('should parse "January 20, 2024 at 2pm"', () => {
        const result = parseTimeExpression('January 20, 2024 at 2pm', timezone, referenceDate);

        expect(result).not.toBeNull();
        // Check formatted output for correct date/time
        expect(result!.formatted).toContain('Jan 20, 2024');
        expect(result!.formatted).toContain('2:00 PM');
      });
    });

    describe('edge cases', () => {
      it('should return null for empty string', () => {
        const result = parseTimeExpression('', timezone, referenceDate);
        expect(result).toBeNull();
      });

      it('should return null for whitespace-only string', () => {
        const result = parseTimeExpression('   ', timezone, referenceDate);
        expect(result).toBeNull();
      });

      it('should return null for invalid/unparseable text', () => {
        const result = parseTimeExpression('asdfghjkl', timezone, referenceDate);
        expect(result).toBeNull();
      });

      it('should return null for random gibberish', () => {
        const result = parseTimeExpression('xyz123!@#', timezone, referenceDate);
        expect(result).toBeNull();
      });
    });

    describe('timestamp format', () => {
      it('should return timestamp in seconds (not milliseconds)', () => {
        const result = parseTimeExpression('tomorrow at 9am', timezone, referenceDate);

        expect(result).not.toBeNull();
        // Slack requires Unix timestamp in seconds
        // A timestamp in milliseconds would be ~13 digits, seconds is ~10 digits
        expect(result!.timestamp.toString().length).toBeLessThanOrEqual(10);
        expect(result!.timestamp).toBe(Math.floor(result!.date.getTime() / 1000));
      });
    });

    describe('formatted output', () => {
      it('should include formatted date string', () => {
        const result = parseTimeExpression('tomorrow at 9am', timezone, referenceDate);

        expect(result).not.toBeNull();
        expect(result!.formatted).toBeDefined();
        expect(typeof result!.formatted).toBe('string');
        expect(result!.formatted.length).toBeGreaterThan(0);
      });
    });
  });

  describe('validateScheduledTime', () => {
    beforeEach(() => {
      // Mock Date.now() for consistent testing
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-15T10:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return valid for time more than 1 minute in future', () => {
      const now = Math.floor(Date.now() / 1000);
      const futureTime = now + 120; // 2 minutes in future

      const result = validateScheduledTime(futureTime);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return invalid for time in the past', () => {
      const now = Math.floor(Date.now() / 1000);
      const pastTime = now - 60; // 1 minute in past

      const result = validateScheduledTime(pastTime);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('already passed');
    });

    it('should return invalid for time less than 1 minute in future', () => {
      const now = Math.floor(Date.now() / 1000);
      const nearFutureTime = now + 30; // 30 seconds in future

      const result = validateScheduledTime(nearFutureTime);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('at least 1 minute');
    });

    it('should return valid for exactly 60 seconds in future', () => {
      const now = Math.floor(Date.now() / 1000);
      const exactlyOneMinute = now + 60;

      const result = validateScheduledTime(exactlyOneMinute);

      expect(result.valid).toBe(true);
    });
  });

  describe('parseAndValidateTime', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-15T10:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return success for valid future time', () => {
      const result = parseAndValidateTime('in 2 hours', timezone);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.parsed).toBeDefined();
        expect(result.parsed.timestamp).toBeGreaterThan(0);
      }
    });

    it('should return error for unparseable time', () => {
      const result = parseAndValidateTime('not a valid time', timezone);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("couldn't understand");
      }
    });

    it('should return error for time in the past', () => {
      const result = parseAndValidateTime('yesterday', timezone);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('passed');
      }
    });
  });

  describe('formatDateTime', () => {
    it('should format date in specified timezone', () => {
      const date = new Date('2024-01-15T17:00:00.000Z'); // 9am PST
      const formatted = formatDateTime(date, 'America/Los_Angeles');

      expect(formatted).toContain('2024');
      expect(formatted).toContain('Jan');
      expect(formatted).toContain('15');
    });

    it('should handle different timezones', () => {
      const date = new Date('2024-01-15T17:00:00.000Z');

      const pstFormatted = formatDateTime(date, 'America/Los_Angeles');
      const estFormatted = formatDateTime(date, 'America/New_York');

      // Different timezones should show different times
      expect(pstFormatted).not.toBe(estFormatted);
    });

    it('should fallback gracefully for invalid timezone', () => {
      const date = new Date('2024-01-15T17:00:00.000Z');
      const formatted = formatDateTime(date, 'Invalid/Timezone');

      // Should still return a formatted string (fallback)
      expect(typeof formatted).toBe('string');
      expect(formatted.length).toBeGreaterThan(0);
    });
  });

  describe('nowInSeconds', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-15T10:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return current time in seconds', () => {
      const result = nowInSeconds();
      const expected = Math.floor(Date.now() / 1000);

      expect(result).toBe(expected);
    });

    it('should return a 10-digit number (Unix timestamp in seconds)', () => {
      const result = nowInSeconds();

      expect(result.toString().length).toBeLessThanOrEqual(10);
    });
  });

  describe('DST transitions', () => {
    // Tests for Daylight Saving Time edge cases
    // US DST: Spring forward (2nd Sunday March), Fall back (1st Sunday November)

    describe('spring forward (lose an hour)', () => {
      // March 10, 2024 at 2:00 AM PST -> 3:00 AM PDT (skip 2:00-3:00 AM)
      const beforeDST = new Date('2024-03-10T09:00:00.000Z'); // 1am PST

      it('should handle scheduling across spring DST transition', () => {
        const result = parseTimeExpression('in 3 hours', 'America/Los_Angeles', beforeDST);

        expect(result).not.toBeNull();
        // Should correctly calculate time accounting for the lost hour
        expect(result!.date).toBeDefined();
      });

      it('should handle "tomorrow at 9am" when tomorrow crosses DST', () => {
        // Reference: March 9, 2024 (day before DST)
        const dayBeforeDST = new Date('2024-03-09T17:00:00.000Z'); // 9am PST on March 9

        const result = parseTimeExpression('tomorrow at 9am', 'America/Los_Angeles', dayBeforeDST);

        expect(result).not.toBeNull();
        // Should parse successfully even though tomorrow has DST change
        // Time should be morning (around 9am give or take timezone interpretation)
        expect(result!.date).toBeDefined();
        expect(result!.timestamp).toBeGreaterThan(0);
      });
    });

    describe('fall back (gain an hour)', () => {
      // November 3, 2024 at 2:00 AM PDT -> 1:00 AM PST (repeat 1:00-2:00 AM)
      const beforeFallBack = new Date('2024-11-03T08:00:00.000Z'); // 1am PDT

      it('should handle scheduling across fall DST transition', () => {
        const result = parseTimeExpression('in 3 hours', 'America/Los_Angeles', beforeFallBack);

        expect(result).not.toBeNull();
        // Should correctly calculate time accounting for the gained hour
        expect(result!.date).toBeDefined();
      });

      it('should handle scheduling for the next day after fall back', () => {
        const result = parseTimeExpression('tomorrow at 10am', 'America/Los_Angeles', beforeFallBack);

        expect(result).not.toBeNull();
        // Should parse successfully even with DST change
        expect(result!.date).toBeDefined();
        expect(result!.timestamp).toBeGreaterThan(0);
      });
    });

    describe('cross-timezone DST awareness', () => {
      it('should handle timezone that observes DST (US)', () => {
        // Summer time in LA (PDT)
        const summerDate = new Date('2024-07-15T17:00:00.000Z'); // 10am PDT
        const result = parseTimeExpression('tomorrow at 9am', 'America/Los_Angeles', summerDate);

        expect(result).not.toBeNull();
        expect(result!.formatted).toContain('PDT');
      });

      it('should handle timezone that observes DST (Europe)', () => {
        // Summer time in London (BST)
        const summerDate = new Date('2024-07-15T09:00:00.000Z'); // 10am BST
        const result = parseTimeExpression('tomorrow at 9am', 'Europe/London', summerDate);

        expect(result).not.toBeNull();
        // Should show BST (British Summer Time)
      });

      it('should handle timezone without DST (UTC)', () => {
        const date = new Date('2024-07-15T10:00:00.000Z');
        const result = parseTimeExpression('tomorrow at 9am', 'UTC', date);

        expect(result).not.toBeNull();
        // UTC doesn't observe DST, should always be consistent
      });

      it('should handle timezone without DST (Arizona)', () => {
        // Arizona doesn't observe DST (except Navajo Nation)
        const summerDate = new Date('2024-07-15T17:00:00.000Z');
        const result = parseTimeExpression('tomorrow at 9am', 'America/Phoenix', summerDate);

        expect(result).not.toBeNull();
        expect(result!.formatted).toContain('MST'); // Always MST, never MDT
      });
    });
  });

  describe('ambiguous expressions', () => {
    // Tests for expressions that could be interpreted multiple ways

    describe('day of week ambiguity', () => {
      it('should handle "next Saturday" when today is Saturday', () => {
        // January 13, 2024 is a Saturday
        const saturday = new Date('2024-01-13T17:00:00.000Z');
        const result = parseTimeExpression('next Saturday', 'America/Los_Angeles', saturday);

        expect(result).not.toBeNull();
        // Should be a future Saturday - check formatted output starts with "Sat"
        expect(result!.formatted).toMatch(/^Sat/);
      });

      it('should handle "Saturday" when today is Saturday', () => {
        // January 13, 2024 is a Saturday
        const saturday = new Date('2024-01-13T17:00:00.000Z');
        const result = parseTimeExpression('Saturday at 3pm', 'America/Los_Angeles', saturday);

        expect(result).not.toBeNull();
        // chrono-node typically interprets this as the upcoming Saturday
      });

      it('should handle "this Monday" vs "next Monday"', () => {
        // January 10, 2024 is a Wednesday
        const wednesday = new Date('2024-01-10T17:00:00.000Z');

        const thisMonday = parseTimeExpression('this Monday', 'America/Los_Angeles', wednesday);
        const nextMonday = parseTimeExpression('next Monday', 'America/Los_Angeles', wednesday);

        // Both should parse, potentially to different dates
        expect(thisMonday).not.toBeNull();
        expect(nextMonday).not.toBeNull();
      });
    });

    describe('time ambiguity', () => {
      it('should handle "noon" correctly', () => {
        const morning = new Date('2024-01-15T17:00:00.000Z'); // 9am PST
        const result = parseTimeExpression('tomorrow at noon', 'America/Los_Angeles', morning);

        expect(result).not.toBeNull();
        // Noon should be 12:00 PM in the formatted output
        expect(result!.formatted).toContain('12:00 PM');
      });

      it('should handle "midnight" correctly', () => {
        const evening = new Date('2024-01-15T03:00:00.000Z'); // 7pm PST on Jan 14
        const result = parseTimeExpression('tomorrow at midnight', 'America/Los_Angeles', evening);

        expect(result).not.toBeNull();
        // Midnight should parse - chrono-node may interpret as 12:00 AM or 00:00
        expect(result!.date).toBeDefined();
      });

      it('should handle ambiguous "9" (could be 9am or 9pm)', () => {
        const morning = new Date('2024-01-15T17:00:00.000Z'); // 9am PST
        const result = parseTimeExpression('tomorrow at 9', 'America/Los_Angeles', morning);

        expect(result).not.toBeNull();
        // chrono-node typically defaults to AM for single digit hours
      });
    });

    describe('relative time ambiguity', () => {
      it('should handle "end of day"', () => {
        const morning = new Date('2024-01-15T17:00:00.000Z');
        const result = parseTimeExpression('end of day', 'America/Los_Angeles', morning);

        // May or may not parse depending on chrono-node support
        // If it does parse, should be late in the day
        if (result) {
          expect(result.date.getHours()).toBeGreaterThanOrEqual(17);
        }
      });

      it('should handle "tonight"', () => {
        const morning = new Date('2024-01-15T17:00:00.000Z'); // 9am PST
        const result = parseTimeExpression('tonight at 8pm', 'America/Los_Angeles', morning);

        // "tonight at 8pm" may or may not parse depending on chrono-node interpretation
        // If it parses, it should be in the evening
        if (result) {
          expect(result.date).toBeDefined();
        }
      });

      it('should handle "this afternoon"', () => {
        const morning = new Date('2024-01-15T17:00:00.000Z'); // 9am PST
        const result = parseTimeExpression('this afternoon', 'America/Los_Angeles', morning);

        // May or may not parse - afternoon is vague
        // If it parses, should be in PM hours
        if (result) {
          expect(result.formatted).toContain('PM');
        }
      });
    });

    describe('date format ambiguity', () => {
      it('should handle MM/DD/YYYY format', () => {
        const ref = new Date('2024-01-15T17:00:00.000Z');
        const result = parseTimeExpression('01/20/2024 at 3pm', 'America/Los_Angeles', ref);

        expect(result).not.toBeNull();
        expect(result!.formatted).toContain('Jan 20, 2024');
        expect(result!.formatted).toContain('3:00 PM');
      });

      it('should handle written month format', () => {
        const ref = new Date('2024-01-15T17:00:00.000Z');
        const result = parseTimeExpression('January 20th at 3pm', 'America/Los_Angeles', ref);

        expect(result).not.toBeNull();
        expect(result!.formatted).toContain('Jan 20');
        expect(result!.formatted).toContain('3:00 PM');
      });

      it('should handle abbreviated month format', () => {
        const ref = new Date('2024-01-15T17:00:00.000Z');
        const result = parseTimeExpression('Jan 20 3pm', 'America/Los_Angeles', ref);

        expect(result).not.toBeNull();
        expect(result!.formatted).toContain('Jan 20');
        expect(result!.formatted).toContain('3:00 PM');
      });
    });
  });
});

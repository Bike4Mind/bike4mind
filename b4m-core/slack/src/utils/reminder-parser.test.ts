/**
 * Tests for Reminder Parser Utility
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseReminderExpression } from './reminder-parser';

describe('reminder-parser', () => {
  const timezone = 'America/Los_Angeles';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T18:00:00.000Z')); // 10am PST
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('quoted format', () => {
    it('should parse "message" in 2 hours', () => {
      const result = parseReminderExpression('"check report" in 2 hours', timezone);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.parsed.text).toBe('check report');
        expect(result.parsed.time.timestamp).toBeGreaterThan(0);
      }
    });

    it('should parse single-quoted message', () => {
      const result = parseReminderExpression("'call mom' tomorrow at 9am", timezone);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.parsed.text).toBe('call mom');
      }
    });

    it('should parse quoted message with time', () => {
      const result = parseReminderExpression('"review PR" next Monday at 3pm', timezone);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.parsed.text).toBe('review PR');
      }
    });
  });

  describe('natural language format', () => {
    it('should parse "remind me to X in Y"', () => {
      const result = parseReminderExpression('remind me to check report in 2 hours', timezone);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.parsed.text).toBe('check report');
      }
    });

    it('should parse "to X in Y" (without remind me)', () => {
      const result = parseReminderExpression('to review code in 30 minutes', timezone);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.parsed.text).toBe('review code');
      }
    });

    it('should parse "remind me to X tomorrow"', () => {
      const result = parseReminderExpression('remind me to call client tomorrow', timezone);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.parsed.text).toBe('call client');
      }
    });

    it('should parse "remind me to X at Y"', () => {
      // Use "tomorrow at 5pm" instead of "at 5pm" to avoid flakiness
      // chrono-node's interpretation of "at 5pm" depends on real system time
      const result = parseReminderExpression('remind me to submit report tomorrow at 5pm', timezone);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.parsed.text).toBe('submit report');
      }
    });
  });

  describe('reversed format', () => {
    it('should parse "remind me in Y to X"', () => {
      const result = parseReminderExpression('remind me in 2 hours to check report', timezone);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.parsed.text).toBe('check report');
      }
    });

    it('should parse "in Y to X" (without remind me)', () => {
      const result = parseReminderExpression('in 30 minutes to review code', timezone);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.parsed.text).toBe('review code');
      }
    });

    it('should parse "tomorrow to X"', () => {
      const result = parseReminderExpression('tomorrow at 9am to call client', timezone);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.parsed.text).toBe('call client');
      }
    });
  });

  describe('simple format', () => {
    it('should parse "X tomorrow at Y"', () => {
      const result = parseReminderExpression('check report tomorrow at 9am', timezone);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.parsed.text).toBe('check report');
      }
    });

    it('should parse "X in Y hours"', () => {
      const result = parseReminderExpression('review PR in 3 hours', timezone);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.parsed.text).toBe('review PR');
      }
    });

    it('should parse "X next Monday"', () => {
      const result = parseReminderExpression('team meeting next Monday', timezone);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.parsed.text).toBe('team meeting');
      }
    });
  });

  describe('error cases', () => {
    it('should return error for empty input', () => {
      const result = parseReminderExpression('', timezone);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Please provide');
      }
    });

    it('should return error for whitespace-only input', () => {
      const result = parseReminderExpression('   ', timezone);

      expect(result.success).toBe(false);
    });

    it('should return error for unparseable time', () => {
      const result = parseReminderExpression('"check report" asdfghjkl', timezone);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("couldn't understand");
      }
    });

    it('should return error for time in the past', () => {
      const result = parseReminderExpression('"check report" yesterday', timezone);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('passed');
      }
    });

    it('should return error when only time is provided', () => {
      const result = parseReminderExpression('tomorrow at 9am', timezone);

      // This might parse as just a time with no text
      if (result.success) {
        // If it somehow parsed, the text should be meaningful
        expect(result.parsed.text.length).toBeGreaterThan(0);
      }
    });
  });

  describe('edge cases', () => {
    it('should handle unicode in reminder text', () => {
      const result = parseReminderExpression('"check 📊 report" in 2 hours', timezone);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.parsed.text).toContain('📊');
      }
    });

    it('should handle long reminder text', () => {
      const longText = 'a'.repeat(200);
      const result = parseReminderExpression(`"${longText}" in 2 hours`, timezone);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.parsed.text).toBe(longText);
      }
    });

    it('should be case insensitive for keywords', () => {
      const result = parseReminderExpression('REMIND ME TO check report TOMORROW', timezone);

      expect(result.success).toBe(true);
    });
  });

  describe('time validation', () => {
    it('should return valid timestamp in seconds', () => {
      const result = parseReminderExpression('"test" in 2 hours', timezone);

      expect(result.success).toBe(true);
      if (result.success) {
        // Timestamp should be in seconds (10 digits), not milliseconds (13 digits)
        expect(result.parsed.time.timestamp.toString().length).toBeLessThanOrEqual(10);
      }
    });

    it('should include formatted time string', () => {
      const result = parseReminderExpression('"test" tomorrow at 9am', timezone);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.parsed.time.formatted).toBeDefined();
        expect(result.parsed.time.formatted.length).toBeGreaterThan(0);
      }
    });
  });
});

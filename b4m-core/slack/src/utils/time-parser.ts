/**
 * Time Parser Utility for Slack Scheduled Messages
 *
 * Parses natural language time expressions and converts them to Unix timestamps.
 * Uses chrono-node for natural language parsing and dayjs for timezone formatting.
 */

import * as chrono from 'chrono-node';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import advancedFormat from 'dayjs/plugin/advancedFormat';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(advancedFormat);

/**
 * Result of parsing a time expression
 */
export interface ParsedTime {
  /** Unix timestamp in seconds (Slack requires seconds, not milliseconds) */
  timestamp: number;
  /** The parsed Date object */
  date: Date;
  /** Human-readable formatted time for confirmation messages */
  formatted: string;
}

/**
 * Validation result for scheduled time
 */
export interface TimeValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Minimum seconds in the future for Slack scheduled messages
 * Slack requires at least 1 minute (60 seconds) in the future
 */
const MIN_SECONDS_IN_FUTURE = 60;

/**
 * Parse a natural language time expression into a timestamp
 *
 * Supports formats like:
 * - "tomorrow at 9am"
 * - "in 2 hours"
 * - "next Monday at 3pm"
 * - "2024-01-15 14:00"
 *
 * @param text - The time expression to parse
 * @param tz - IANA timezone string (e.g., "America/Los_Angeles")
 * @param referenceDate - Optional reference date for relative times (defaults to now)
 * @returns ParsedTime object or null if parsing fails
 */
export function parseTimeExpression(text: string, tz: string, referenceDate?: Date): ParsedTime | null {
  if (!text || !text.trim()) {
    return null;
  }

  try {
    // Create a reference date in the user's timezone
    const refDate = referenceDate || new Date();

    // Get timezone offset in minutes for chrono-node
    // chrono-node needs the offset, not IANA string, for proper parsing
    const tzOffsetMinutes = dayjs(refDate).tz(tz).utcOffset();

    // Parse with chrono-node using timezone offset
    const results = chrono.parse(text, {
      instant: refDate,
      timezone: tzOffsetMinutes,
    });

    if (results.length === 0) {
      return null;
    }

    // Get the first (most relevant) parsed result
    const parsed = results[0];
    const date = parsed.date();

    if (!date || isNaN(date.getTime())) {
      return null;
    }

    // Convert to Unix timestamp in seconds (Slack requirement)
    const timestamp = Math.floor(date.getTime() / 1000);

    // Format for display
    const formatted = formatDateTime(date, tz);

    return {
      timestamp,
      date,
      formatted,
    };
  } catch {
    return null;
  }
}

/**
 * Validate that a scheduled time meets Slack's requirements
 *
 * @param timestamp - Unix timestamp in seconds
 * @returns Validation result with error message if invalid
 */
export function validateScheduledTime(timestamp: number): TimeValidationResult {
  const now = Math.floor(Date.now() / 1000);
  const secondsUntil = timestamp - now;

  if (secondsUntil < 0) {
    return {
      valid: false,
      error: 'That time has already passed. Please specify a future time.',
    };
  }

  if (secondsUntil < MIN_SECONDS_IN_FUTURE) {
    return {
      valid: false,
      error: 'Messages must be scheduled at least 1 minute in advance.',
    };
  }

  return { valid: true };
}

/**
 * Parse and validate a time expression in one step
 *
 * @param text - The time expression to parse
 * @param tz - IANA timezone string
 * @returns Object with parsed time or error message
 */
export function parseAndValidateTime(
  text: string,
  tz: string
): { success: true; parsed: ParsedTime } | { success: false; error: string } {
  const parsed = parseTimeExpression(text, tz);

  if (!parsed) {
    return {
      success: false,
      error:
        "I couldn't understand that time. Try formats like 'tomorrow at 9am', 'in 2 hours', or '2024-01-15 14:00'.",
    };
  }

  const validation = validateScheduledTime(parsed.timestamp);

  if (!validation.valid && validation.error) {
    return {
      success: false,
      error: validation.error,
    };
  }

  return {
    success: true,
    parsed,
  };
}

/**
 * Format a date for display in a specific timezone
 *
 * @param date - Date to format
 * @param tz - IANA timezone string
 * @returns Formatted string like "Mon, Jan 28, 2024 at 9:00 AM PST"
 */
export function formatDateTime(date: Date, tz: string): string {
  try {
    const d = dayjs(date).tz(tz);
    // Format: "Mon, Jan 28, 2024 at 9:00 AM PST"
    const formatted = d.format('ddd, MMM D, YYYY [at] h:mm A');
    // Get timezone abbreviation
    const tzAbbr = d.format('z');
    return `${formatted} ${tzAbbr}`;
  } catch {
    // Fallback if timezone is invalid
    return dayjs(date).format('ddd, MMM D, YYYY [at] h:mm A');
  }
}

/**
 * Get the current Unix timestamp in seconds
 */
export function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

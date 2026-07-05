/**
 * Reminder Parser Utility
 *
 * Parses reminder text from natural language patterns like:
 * - "remind me to X in Y"
 * - "remind me in Y to X"
 * - "X tomorrow at 9am"
 * - "check the report" in 2 hours (quoted format)
 */

import { parseAndValidateTime, ParsedTime } from './time-parser';

/**
 * Result of parsing a reminder expression
 */
export interface ParsedReminder {
  /** The reminder text (what to remind about) */
  text: string;
  /** The parsed time information */
  time: ParsedTime;
}

/**
 * Parse a reminder expression into text and time components
 *
 * Supports multiple formats:
 * 1. Quoted: "check report" in 2 hours
 * 2. Natural: remind me to check report in 2 hours
 * 3. Natural (reversed): remind me in 2 hours to check report
 * 4. Simple: check report tomorrow at 9am
 *
 * @param input - The reminder expression to parse
 * @param timezone - IANA timezone string
 * @returns Parsed reminder or error
 */
export function parseReminderExpression(
  input: string,
  timezone: string
): { success: true; parsed: ParsedReminder } | { success: false; error: string } {
  const trimmed = input.trim();

  if (!trimmed) {
    return {
      success: false,
      error: 'Please provide reminder text and time. Example: `/b4m remind check report tomorrow at 9am`',
    };
  }

  // Pattern 1: Quoted format - "message" time_expression
  const quotedMatch = trimmed.match(/^["'](.+?)["']\s+(.+)$/);
  if (quotedMatch) {
    const [, text, timeExpr] = quotedMatch;
    return parseWithTextAndTime(text, timeExpr, timezone);
  }

  // Pattern 2: "remind me to X in/at/on Y" or "to X in/at/on Y"
  const remindMeToMatch = trimmed.match(
    /^(?:remind\s+me\s+)?to\s+(.+?)\s+(in|at|on|tomorrow|next|tonight|today)\s*(.*)$/i
  );
  if (remindMeToMatch) {
    const [, text, timeStart, timeRest] = remindMeToMatch;
    const timeExpr = `${timeStart} ${timeRest}`.trim();
    return parseWithTextAndTime(text, timeExpr, timezone);
  }

  // Pattern 3: "remind me in/at/on Y to X" (reversed)
  const remindMeInMatch = trimmed.match(
    /^(?:remind\s+me\s+)?(in|at|on|tomorrow|next|tonight|today)\s+(.+?)\s+to\s+(.+)$/i
  );
  if (remindMeInMatch) {
    const [, timeStart, timeRest, text] = remindMeInMatch;
    const timeExpr = `${timeStart} ${timeRest}`.trim();
    return parseWithTextAndTime(text, timeExpr, timezone);
  }

  // Pattern 4: Try to find time expression at the end
  // Split on common time indicators and try parsing
  const timeIndicators = [
    'tomorrow',
    'today',
    'tonight',
    'next week',
    'next monday',
    'next tuesday',
    'next wednesday',
    'next thursday',
    'next friday',
    'next saturday',
    'next sunday',
    'in \\d+',
    'at \\d+',
    'on \\w+',
  ];

  const timePattern = new RegExp(`(.+?)\\s+((?:${timeIndicators.join('|')}).*)$`, 'i');
  const simpleMatch = trimmed.match(timePattern);
  if (simpleMatch) {
    const [, text, timeExpr] = simpleMatch;
    return parseWithTextAndTime(text.trim(), timeExpr.trim(), timezone);
  }

  // Fallback: Try parsing the whole thing as time (maybe just time was given)
  const timeResult = parseAndValidateTime(trimmed, timezone);
  if (timeResult.success) {
    return {
      success: false,
      error: 'Please include what you want to be reminded about. Example: `/b4m remind check report tomorrow at 9am`',
    };
  }

  return {
    success: false,
    error:
      "I couldn't parse that reminder. Try:\n" +
      '• `/b4m remind check report tomorrow at 9am`\n' +
      '• `/b4m remind "call mom" in 2 hours`\n' +
      '• `/b4m remind to review PR next Monday`',
  };
}

/**
 * Parse with known text and time expression
 */
function parseWithTextAndTime(
  text: string,
  timeExpr: string,
  timezone: string
): { success: true; parsed: ParsedReminder } | { success: false; error: string } {
  const cleanText = text.trim();

  if (!cleanText) {
    return {
      success: false,
      error: 'Please include what you want to be reminded about.',
    };
  }

  const timeResult = parseAndValidateTime(timeExpr, timezone);

  if (!timeResult.success) {
    return {
      success: false,
      error: timeResult.error,
    };
  }

  return {
    success: true,
    parsed: {
      text: cleanText,
      time: timeResult.parsed,
    },
  };
}

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
  const quotedMatch = matchQuotedText(trimmed);
  if (quotedMatch) {
    const [text, timeExpr] = quotedMatch;
    return parseWithTextAndTime(text, timeExpr, timezone);
  }

  // Pattern 2: "remind me to X in/at/on Y" or "to X in/at/on Y"
  const remindMeToMatch = matchRemindMeTo(trimmed);
  if (remindMeToMatch) {
    const [text, timeStart, timeRest] = remindMeToMatch;
    const timeExpr = `${timeStart} ${timeRest}`.trim();
    return parseWithTextAndTime(text, timeExpr, timezone);
  }

  // Pattern 3: "remind me in/at/on Y to X" (reversed)
  const remindMeInMatch = matchRemindMeIn(trimmed);
  if (remindMeInMatch) {
    const [timeStart, timeRest, text] = remindMeInMatch;
    const timeExpr = `${timeStart} ${timeRest}`.trim();
    return parseWithTextAndTime(text, timeExpr, timezone);
  }

  // Pattern 4: a time expression at the end
  const simpleMatch = matchTrailingTime(trimmed);
  if (simpleMatch) {
    const [text, timeExpr] = simpleMatch;
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

// Hand scanners for the reminder patterns. Each returns the same captures as the regex in
// its doc comment, but in linear time: those regexes backtracked quadratically or worse on
// runs of whitespace in Slack message text. `.` there excludes line terminators and
// `\s` spans them, which is why the scanners track both.

const WHITESPACE = /\s/;

function isLineTerminator(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
}

/** `wsEnd[i]` ends the whitespace run at i (i itself when s[i] is not whitespace); `lineEnd[i]` is the next line terminator at or after i. */
interface ScanIndex {
  s: string;
  n: number;
  wsEnd: Int32Array;
  lineEnd: Int32Array;
  lastLineTerminator: number;
}

function indexText(s: string): ScanIndex {
  const n = s.length;
  const wsEnd = new Int32Array(n + 1);
  const lineEnd = new Int32Array(n + 1);
  wsEnd[n] = n;
  lineEnd[n] = n;
  let lastLineTerminator = -1;
  for (let i = n - 1; i >= 0; i--) {
    wsEnd[i] = WHITESPACE.test(s[i]) ? wsEnd[i + 1] : i;
    const lt = isLineTerminator(s, i);
    lineEnd[i] = lt ? i : lineEnd[i + 1];
    if (lt && lastLineTerminator < 0) lastLineTerminator = i;
  }
  return { s, n, wsEnd, lineEnd, lastLineTerminator };
}

const isWs = (ix: ScanIndex, i: number) => i < ix.n && ix.wsEnd[i] !== i;

/** Case-insensitive match of a lowercase ASCII `word` at i, as the `i` flag compares ASCII letters. */
function wordAt(s: string, i: number, word: string): boolean {
  if (i + word.length > s.length) return false;
  for (let j = 0; j < word.length; j++) {
    let c = s.charCodeAt(i + j);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== word.charCodeAt(j)) return false;
  }
  return true;
}

/** Start of the `(.+)$` group in `\s{min,}(.+)$` at p, or -1. */
function restOfText(ix: ScanIndex, p: number, min: 0 | 1): number {
  if (min === 1 && !isWs(ix, p)) return -1;
  const w = ix.wsEnd[p];
  if (w < ix.n) return ix.lastLineTerminator < w ? w : -1;
  const last = ix.n - 1;
  return last >= p + min && !isLineTerminator(ix.s, last) ? last : -1;
}

/**
 * `\s+(.+?)\s+TAIL` at a, where TAIL starts with a non-whitespace literal and `tailAt(k)`
 * says whether it matches at k. Returns the lazy group's span and the tail's result.
 */
function lazyGroupBeforeTail<T>(
  ix: ScanIndex,
  a: number,
  tailAt: (k: number) => T | null
): { start: number; end: number; tail: T } | null {
  if (!isWs(ix, a)) return null;
  const w = ix.wsEnd[a];
  const limit = Math.min(ix.lineEnd[w], ix.n - 1);
  for (let g = w + 1; g <= limit; g++) {
    if (!isWs(ix, g)) continue;
    const k = ix.wsEnd[g];
    const tail = tailAt(k);
    if (tail !== null) return { start: w, end: g, tail };
    g = k;
  }
  // Backtracking into the leading run: the group becomes one whitespace character, the
  // last one in [a+1, w-2] that is not a line terminator.
  for (let g0 = w - 2; g0 > a; g0--) {
    if (isLineTerminator(ix.s, g0)) continue;
    const tail = tailAt(w);
    return tail === null ? null : { start: g0, end: g0 + 1, tail };
  }
  return null;
}

/** `/^["'](.+?)["']\s+(.+)$/` -> [text, rest]. Also used by scheduleCommands on untrimmed text. */
export function matchQuotedText(s: string): [string, string] | null {
  if (s[0] !== '"' && s[0] !== "'") return null;
  const ix = indexText(s);
  for (let j = 2; j < ix.n; j++) {
    if (isLineTerminator(s, j - 1)) return null;
    if (s[j] !== '"' && s[j] !== "'") continue;
    const rest = restOfText(ix, j + 1, 1);
    if (rest >= 0) return [s.slice(1, j), s.slice(rest)];
  }
  return null;
}

const TIME_KEYWORDS = ['in', 'at', 'on', 'tomorrow', 'next', 'tonight', 'today'];

/** End of an optional leading `remind\s+me\s+`, or -1 when the text starts with `remind` but not that prefix. */
function afterRemindMe(ix: ScanIndex): number {
  if (!wordAt(ix.s, 0, 'remind')) return 0;
  if (!isWs(ix, 6)) return -1;
  const me = ix.wsEnd[6];
  return wordAt(ix.s, me, 'me') && isWs(ix, me + 2) ? ix.wsEnd[me + 2] : -1;
}

/** `/^(?:remind\s+me\s+)?to\s+(.+?)\s+(KEYWORD)\s*(.*)$/i` -> [text, keyword, rest]. */
export function matchRemindMeTo(s: string): [string, string, string] | null {
  const ix = indexText(s);
  const to = afterRemindMe(ix);
  if (to < 0 || !wordAt(s, to, 'to')) return null;
  const m = lazyGroupBeforeTail(ix, to + 2, k => {
    for (const kw of TIME_KEYWORDS) {
      if (!wordAt(s, k, kw)) continue;
      const rest = ix.wsEnd[k + kw.length];
      if (ix.lastLineTerminator < rest) return [s.slice(k, k + kw.length), s.slice(rest)] as const;
    }
    return null;
  });
  return m ? [s.slice(m.start, m.end), m.tail[0], m.tail[1]] : null;
}

/** `/^(?:remind\s+me\s+)?(KEYWORD)\s+(.+?)\s+to\s+(.+)$/i` -> [keyword, time, text]. */
export function matchRemindMeIn(s: string): [string, string, string] | null {
  const ix = indexText(s);
  const at = afterRemindMe(ix);
  if (at < 0) return null;
  for (const kw of TIME_KEYWORDS) {
    if (!wordAt(s, at, kw)) continue;
    const m = lazyGroupBeforeTail(ix, at + kw.length, k => {
      if (!wordAt(s, k, 'to')) return null;
      const rest = restOfText(ix, k + 2, 1);
      return rest >= 0 ? rest : null;
    });
    if (m) return [s.slice(at, at + kw.length), s.slice(m.start, m.end), s.slice(m.tail)];
  }
  return null;
}

const TRAILING_TIME_WORDS = [
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
];

function trailingTimeAt(s: string, k: number): boolean {
  if (TRAILING_TIME_WORDS.some(word => wordAt(s, k, word))) return true;
  const c = s.charCodeAt(k + 3);
  if (wordAt(s, k, 'in ') || wordAt(s, k, 'at ')) return c >= 48 && c <= 57;
  return wordAt(s, k, 'on ') && /\w/.test(s[k + 3] ?? '');
}

/** `/(.+?)\s+((?:TRAILING_TIME).*)$/i` (unanchored) -> [text, time]. */
export function matchTrailingTime(s: string): [string, string] | null {
  const ix = indexText(s);
  // nextOk[g]: the first g' >= g where `\s+` can start and the time phrase follows its run.
  const nextOk = new Int32Array(ix.n + 2).fill(ix.n + 1);
  for (let g = ix.n - 1; g >= 0; g--) {
    const k = ix.wsEnd[g];
    const ok = isWs(ix, g) && ix.lastLineTerminator < k && trailingTimeAt(s, k);
    nextOk[g] = ok ? g : nextOk[g + 1];
  }
  for (let st = 0; st < ix.n; st++) {
    const g = nextOk[st + 1];
    if (g <= ix.lineEnd[st] && g < ix.n) return [s.slice(st, g), s.slice(ix.wsEnd[g])];
  }
  return null;
}

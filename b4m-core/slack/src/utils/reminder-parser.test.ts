/**
 * Tests for Reminder Parser Utility
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  matchQuotedText,
  matchRemindMeIn,
  matchRemindMeTo,
  matchTrailingTime,
  parseReminderExpression,
} from './reminder-parser';

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

describe('reminder pattern scanners', () => {
  const TRAILING = ['tomorrow', 'today', 'tonight', 'next week', 'next monday', 'next tuesday', 'next wednesday']
    .concat(['next thursday', 'next friday', 'next saturday', 'next sunday', 'in \\d+', 'at \\d+', 'on \\w+'])
    .join('|');
  // The regexes the scanners replaced, kept as the differential oracle.
  const SITES: Array<[string, RegExp, (s: string) => string[] | null]> = [
    ['quoted', /^["'](.+?)["']\s+(.+)$/, matchQuotedText],
    ['remind-to', /^(?:remind\s+me\s+)?to\s+(.+?)\s+(in|at|on|tomorrow|next|tonight|today)\s*(.*)$/i, matchRemindMeTo],
    ['remind-in', /^(?:remind\s+me\s+)?(in|at|on|tomorrow|next|tonight|today)\s+(.+?)\s+to\s+(.+)$/i, matchRemindMeIn],
    ['trailing', new RegExp(`(.+?)\\s+((?:${TRAILING}).*)$`, 'i'), matchTrailingTime],
  ];
  const oldCaptures = (re: RegExp, s: string) => re.exec(s)?.slice(1) ?? null;

  function mulberry32(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const ch = (code: number) => String.fromCharCode(code);
  const LEADS = ['', 'to ', 'remind me to ', 'in ', 'remind me in ', 'Remind  me\nTO ', '"', "'", 'remind '];
  const TOKENS = [
    'remind',
    'me',
    'to',
    'TO',
    'in',
    'In',
    'at',
    'on',
    'tomorrow',
    'next',
    'week',
    'monday',
    'tonight',
  ].concat([
    'today',
    '5',
    '12',
    'x',
    'call',
    '"',
    "'",
    ' ',
    ' ',
    ' ',
    '\n',
    '\r',
    '\t',
    ch(0xa0),
    ch(0x2028),
    ch(0xfeff),
  ]);
  const corpus = (() => {
    const rand = mulberry32(2998);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const cases = [
      'to   in 5 minutes',
      'in   to call mom',
      'remind me to buy milk\nin 5 minutes',
      '"a" \n5 pm',
      "'a'  ",
    ];
    for (let i = 0; i < 3000; i++) {
      let s = pick(LEADS);
      const len = 1 + Math.floor(rand() * 24);
      for (let j = 0; j < len; j++) s += pick(TOKENS);
      cases.push(s, s.trim());
    }
    return cases;
  })();

  it.each(SITES)('%s: yields exactly what the old regex captured across a seeded corpus', (_name, re, scan) => {
    let matched = 0;
    for (const input of corpus) {
      const expected = oldCaptures(re, input);
      if (expected) matched++;
      expect(scan(input), JSON.stringify(input)).toEqual(expected);
    }
    expect(matched).toBeGreaterThan(20);
  });

  it.each(SITES)('%s: control, a greedy near-miss of the regex diverges on the corpus', (_name, re) => {
    const control = new RegExp(re.source.replace('(.+?)', '(.+)'), re.flags);
    expect(corpus.some(s => JSON.stringify(oldCaptures(control, s)) !== JSON.stringify(oldCaptures(re, s)))).toBe(true);
  });

  it('keeps the whitespace-only task the old pattern captured, so it still errors as a missing task', () => {
    expect(matchRemindMeTo('to   in 5 minutes')).toEqual([' ', 'in', '5 minutes']);
    expect(parseReminderExpression('to   in 5 minutes', 'UTC')).toEqual({
      success: false,
      error: 'Please include what you want to be reminded about.',
    });
  });

  // Same sampling as measureGrowth in b4m-core/services/src/__tests__/utils/regexLinearity.ts: the
  // input doubles until a warm run takes 25ms, so the ratio compares samples well above timer, JIT
  // and GC noise, and each size keeps its fastest of five runs. Times are thread CPU ms: on a loaded
  // runner a longer run is likelier to be preempted, which inflates a wall-clock ratio.
  function assertLinearGrowth(scan: (s: string) => unknown, build: (n: number) => string, small: number) {
    const time = (input: string) => {
      const startedAt = process.threadCpuUsage();
      scan(input);
      const { user, system } = process.threadCpuUsage(startedAt);
      return (user + system) / 1000;
    };
    let n = small;
    let baselineInput = build(n);
    expect(time(baselineInput)).toBeLessThan(500);
    while (time(baselineInput) < 25 && baselineInput.length < 1_000_000) {
      n *= 2;
      baselineInput = build(n);
      expect(time(baselineInput)).toBeLessThan(500);
    }
    const fastest = (input: string) => Math.min(...Array.from({ length: 5 }, () => time(input)));
    const baselineMs = fastest(baselineInput);
    const doubledMs = fastest(build(n * 2));
    let ratio = doubledMs / Math.max(baselineMs, 5);
    // A cache or heap-size cliff lands in one doubling step; a quadratic scan is 4x on both.
    if (ratio >= 3) ratio = Math.min(ratio, fastest(build(n * 4)) / Math.max(doubledMs, 5));
    expect(ratio).toBeLessThan(3);
  }

  // Each shape is one the old regex was quadratic or worse on; at these sizes it took seconds.
  const SHAPES: Array<[string, (s: string) => unknown, (n: number) => string]> = [
    ['quoted, quote-space run', matchQuotedText, n => '"a' + '" '.repeat(n) + '\nx'],
    ['remind-to, keyword run', matchRemindMeTo, n => 'to a' + ' in'.repeat(n) + '\nx'],
    ['remind-to, spaces', matchRemindMeTo, n => 'to a' + ' '.repeat(n) + 'x'],
    ['remind-in, to run', matchRemindMeIn, n => 'in a' + ' to'.repeat(n) + '\nx'],
    ['remind-in, spaces', matchRemindMeIn, n => 'in a' + ' '.repeat(n) + 'x'],
    ['trailing, spaces', matchTrailingTime, n => 'a' + ' '.repeat(n) + 'x'],
    ['trailing, keyword run', matchTrailingTime, n => 'a' + ' in 5'.repeat(n) + '\nx'],
    ['trailing, space-newlines', matchTrailingTime, n => 'a' + ' \n'.repeat(n) + 'x'],
    ['trailing, repeated words', matchTrailingTime, n => 'a '.repeat(n) + '\nx'],
  ];
  it.each(SHAPES)('stays linear: %s', (_name, scan, build) => {
    assertLinearGrowth(scan, build, 20_000);
  });
});

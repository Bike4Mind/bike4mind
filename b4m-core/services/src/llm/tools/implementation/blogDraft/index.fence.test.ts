import { afterEach, describe, it, expect, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import { matchNewlineFence, parseTransformationResult } from './index';
import {
  FENCE_PIECES,
  GROWTH_RATIO_CEILING,
  SMALL_INPUT_MS_CEILING,
  measureGrowth,
  regexDivergences,
  seededCorpus,
} from '../../../../__tests__/utils/regexLinearity';

// sanitizeJsonString rebuilds its input one char at a time; at calibrated sizes that allocation churn,
// not the fence scan under test, would dominate the growth timing.
vi.mock('../../utils/jsonSanitize', () => ({ sanitizeJsonString: (s: string) => s }));

const PAIRS: Array<[RegExp, RegExp]> = [
  [/```json\s*\n([\s\S]*?)\n```/, /```json[^\S\n]*\n([\s\S]*?)\n```/],
  [/```\s*\n([\s\S]*?)\n```/, /```[^\S\n]*\n([\s\S]*?)\n```/],
];

describe('parseTransformationResult - fence regexes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(PAIRS)('%s agrees with its replacement except where extra blank lines precede the closer', (oldRe, newRe) => {
    const corpus = seededCorpus(2998, 3000, FENCE_PIECES);
    // The old \s* could swallow blank lines and then find a later closer; the only corpus inputs
    // that diverge have a blank line directly before a closer, which parse to an error either way.
    const diverged = regexDivergences(oldRe, newRe, corpus);
    expect(diverged.every(s => /\n[^\S\n]*\n```/.test(s))).toBe(true);
    expect(corpus.filter(s => newRe.test(s)).length).toBeGreaterThan(50);
  });

  it('pins the known divergence: both sides still fail to parse', () => {
    const input = '```json\n\n```x\n```';
    expect(input.match(PAIRS[0][0])?.[1]).toBe('```x');
    expect(input.match(PAIRS[0][1])?.[1]).toBe('');
    expect(() => parseTransformationResult(input)).toThrow();
  });

  it.each([
    [PAIRS[0][1], 'json'],
    [PAIRS[1][1], ''],
  ] as const)('matchNewlineFence captures exactly what %s did', (re, lang) => {
    const corpus = seededCorpus(2998, 8000, FENCE_PIECES, 16);
    expect(corpus.filter(s => re.test(s)).length).toBeGreaterThan(50);
    expect(corpus.filter(s => matchNewlineFence(s, lang) !== (s.match(re)?.[1] ?? null))).toEqual([]);
  });

  it.each([
    ['an unclosed fence followed by whitespace', (n: number) => '```json' + ' \n'.repeat(n) + 'x', 64000],
    ['repeated json openers with no newline closer', (n: number) => '```json\nx'.repeat(n), 40000],
    ['repeated bare openers with no newline closer', (n: number) => '```\nx'.repeat(n), 40000],
    ['a whitespace run before a missing closer', (n: number) => 'a' + ' '.repeat(n) + 'b', 40000],
  ])('stays linear on %s', (_label, build, small) => {
    // The failure path logs the whole response. Printing it, or letting the spy retain every call's
    // megabyte input, would put console I/O and GC in the timing, so each run drops its recorded call.
    const logError = vi.spyOn(Logger.globalInstance, 'error').mockImplementation(() => {});
    const run = (s: string) => {
      try {
        parseTransformationResult(s);
      } catch {
        // Unparseable by design; only the time matters.
      }
      logError.mockClear();
    };
    const { baselineMs, ratio } = measureGrowth(run, build, small);
    expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
    expect(ratio).toBeLessThan(GROWTH_RATIO_CEILING);
  });
});

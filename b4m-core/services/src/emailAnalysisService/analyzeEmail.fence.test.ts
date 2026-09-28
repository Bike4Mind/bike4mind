import { describe, it, expect } from 'vitest';
import { extractJsonFromResponse } from './analyzeEmail';
import {
  FENCE_PIECES,
  GROWTH_RATIO_CEILING,
  SMALL_INPUT_MS_CEILING,
  measureGrowth,
  regexDivergences,
  seededCorpus,
} from '../__tests__/utils/regexLinearity';

const PAIRS: Array<[string, RegExp, RegExp]> = [
  ['json fence', /```json\s*([\s\S]*?)\s*```/, /```json([\s\S]*?)```/],
  ['bare fence', /```\s*([\s\S]*?)\s*```/, /```([\s\S]*?)```/],
];

describe('extractJsonFromResponse - code fence regexes', () => {
  it('still unwraps fenced JSON with surrounding whitespace', () => {
    expect(extractJsonFromResponse('```json\n  {"a": 1}\n\n```')).toBe('{"a": 1}');
    expect(extractJsonFromResponse('text ```\n{"b": 2} ``` more')).toBe('{"b": 2}');
  });

  // The old pair took about 2s per call at n=2000 on these unclosed shapes.
  it.each([
    ['json fence', (n: number) => '```json' + '\n'.repeat(n) + 'x'],
    ['bare fence', (n: number) => '```' + '\n'.repeat(n) + 'x'],
  ])('stays linear on an unclosed %s followed by whitespace', (_label, build) => {
    const { baselineMs, ratio } = measureGrowth(extractJsonFromResponse, build, 2000);
    expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
    expect(ratio).toBeLessThan(GROWTH_RATIO_CEILING);
  });

  it.each(PAIRS)('%s matches the old regex on every seeded input once captures are trimmed', (_label, oldRe, newRe) => {
    const corpus = seededCorpus(2998, 3000, FENCE_PIECES);
    expect(corpus.filter(s => newRe.test(s)).length).toBeGreaterThan(300);
    expect(regexDivergences(oldRe, newRe, corpus)).toEqual([]);
    expect(regexDivergences(oldRe, new RegExp(newRe.source.replace('*?', '*')), corpus).length).toBeGreaterThan(0);
  });
});

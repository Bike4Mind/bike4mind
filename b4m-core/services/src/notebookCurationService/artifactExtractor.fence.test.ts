import { describe, it, expect } from 'vitest';
import { CODE_BLOCK_REGEX } from './artifactExtractor';
import {
  FENCE_PIECES,
  GROWTH_RATIO_CEILING,
  SMALL_INPUT_MS_CEILING,
  measureGrowth,
  regexDivergences,
  seededCorpus,
} from '../__tests__/utils/regexLinearity';

const OLD = /```(\w+)?\s*([\s\S]*?)```/g;

describe('CODE_BLOCK_REGEX', () => {
  it('matches the old regex on every seeded input once captures are trimmed', () => {
    const corpus = seededCorpus(2998, 3000, [...FENCE_PIECES, 'py', 'a1_']);
    expect(corpus.filter(s => new RegExp(CODE_BLOCK_REGEX).test(s)).length).toBeGreaterThan(500);
    expect(regexDivergences(OLD, CODE_BLOCK_REGEX, corpus)).toEqual([]);
    expect(regexDivergences(OLD, /```(\w*)([\s\S]*)```/g, corpus).length).toBeGreaterThan(0);
  });

  it.each([
    ['a long language run then whitespace', (n: number) => '```' + 'a'.repeat(n) + ' '.repeat(n)],
    ['whitespace', (n: number) => '```' + '\n'.repeat(n * 2) + 'x'],
  ])('stays linear on an unclosed fence followed by %s', (_label, build) => {
    const { baselineMs, ratio } = measureGrowth(s => [...s.matchAll(CODE_BLOCK_REGEX)], build, 64000);
    expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
    expect(ratio).toBeLessThan(GROWTH_RATIO_CEILING);
  });
});

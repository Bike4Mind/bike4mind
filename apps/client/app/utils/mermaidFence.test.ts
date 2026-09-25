import { describe, it, expect } from 'vitest';
import {
  GROWTH_RATIO_CEILING,
  SMALL_INPUT_MS_CEILING,
  measureGrowth,
  regexDivergences,
  seededCorpus,
} from '@client/__tests__/utils/regexLinearity';
import { extractMermaidFence } from './mermaidFence';

describe('extractMermaidFence', () => {
  const OLD_FENCE = /```mermaid\s*([\s\S]*?)```/;
  const NEW_FENCE = /```mermaid([\s\S]*?)```/;

  it('returns the trimmed body, an empty string for an empty fence, and null with no fence', () => {
    expect(extractMermaidFence('see\n```mermaid\n graph TD; A-->B \n```')).toBe('graph TD; A-->B');
    expect(extractMermaidFence('```mermaid\n```')).toBe('');
    expect(extractMermaidFence('graph TD; A-->B')).toBeNull();
  });

  // The old regex took about 1s per call at these sizes.
  it.each([
    ['newlines after an unclosed fence', (n: number) => '```mermaid' + '\n'.repeat(n) + 'x', 160000],
    ['space-newline pairs after an unclosed fence', (n: number) => '```mermaid' + ' \n'.repeat(n) + 'x', 80000],
  ])('stays linear on %s', (_label, build, small) => {
    const { baselineMs, ratio } = measureGrowth(extractMermaidFence, build, small);
    expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
    expect(ratio).toBeLessThan(GROWTH_RATIO_CEILING);
  });

  it('matches the old regex on every seeded input once captures are trimmed', () => {
    const pieces = ['```', '```mermaid', 'mermaid', ' ', '\n', '\t', '\r', 'graph TD', 'x', '`'];
    const corpus = seededCorpus(2998, 3000, pieces);
    expect(corpus.filter(s => NEW_FENCE.test(s)).length).toBeGreaterThan(500);
    expect(regexDivergences(OLD_FENCE, NEW_FENCE, corpus)).toEqual([]);
    // Control: a greedy body does diverge, so this differential can fail.
    expect(regexDivergences(OLD_FENCE, /```mermaid([\s\S]*)```/, corpus).length).toBeGreaterThan(0);
  });
});

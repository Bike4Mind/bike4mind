import { describe, it, expect } from 'vitest';
import { scanArtifactTags } from './scanArtifactTags';
import {
  GROWTH_RATIO_CEILING,
  SMALL_INPUT_MS_CEILING,
  measureGrowth,
  seededCorpus,
} from '../__tests__/utils/regexLinearity';

const OLD = {
  sameLine: /<artifact\s+(.*?)>([\s\S]*?)<\/artifact>/gi,
  crossLine: /<artifact\s+([^>]*)>([\s\S]*?)<\/artifact>/gi,
};
const PIECES = [
  '<artifact',
  '<ARTIFACT',
  '<artifactx',
  ' ',
  '\n',
  '\t',
  '\r',
  '\u2028',
  'a',
  'type="x"',
  '>',
  '</artifact>',
  '</Artifact>',
  '<',
];

describe.each([
  ['sameLine', false],
  ['crossLine', true],
] as const)('scanArtifactTags (%s)', (mode, crossLines) => {
  it('returns exactly what the regex it replaces returns', () => {
    const corpus = seededCorpus(2998, 4000, PIECES, 16);
    const toPairs = (s: string) => [...s.matchAll(OLD[mode])].map(m => [m[1], m[2]]);
    expect(corpus.filter(s => toPairs(s).length > 0).length).toBeGreaterThan(200);
    const diverged = corpus.filter(
      s => JSON.stringify(scanArtifactTags(s, crossLines).map(t => [t.attrs, t.body])) !== JSON.stringify(toPairs(s))
    );
    expect(diverged).toEqual([]);
  });

  // The regexes rescan the rest of the input from every unclosed opener (quadratic), and their
  // \s+ overlapped the attrs class on a single opener's whitespace.
  it.each([
    ['repeated unclosed tags', (n: number) => '<artifact a>'.repeat(n)],
    ['repeated bare openers', (n: number) => '<artifact '.repeat(n)],
    ['one opener then whitespace', (n: number) => '<artifact' + ' '.repeat(n * 10) + 'x'],
    ['openers ending mid-line', (n: number) => '<artifact a\n'.repeat(n) + '>'],
  ])('stays linear on %s', (_label, build) => {
    const { baselineMs, ratio } = measureGrowth(s => scanArtifactTags(s, crossLines), build, 20000);
    expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
    expect(ratio).toBeLessThan(GROWTH_RATIO_CEILING);
  });
});

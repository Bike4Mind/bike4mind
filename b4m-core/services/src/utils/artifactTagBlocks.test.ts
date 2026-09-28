import { describe, expect, it } from 'vitest';
import { expectLinearGrowth } from '../__tests__/expectLinearGrowth';
import { matchArtifactTagBlocks, matchToolArtifactTagBlocks, stripArtifactTagBlocks } from './artifactTagBlocks';

// The regexes these scanners replaced, in notebookCurationService/artifactExtractor.ts,
// notebookCurationService/markdownGenerator.ts and llm/sharedToolBuilder.ts.
const OLD_EXTRACTOR = /<artifact\s+(.*?)>([\s\S]*?)<\/artifact>/gi;
const OLD_MARKDOWN = /<artifact\s+.*?>([\s\S]*?)<\/artifact>/gi;
const OLD_TOOL = /<artifact\s+([^>]*)>([\s\S]*?)<\/artifact>/gi;

function oldBlocks(re: RegExp, content: string) {
  return [...content.matchAll(re)].map(m => ({
    index: m.index,
    end: m.index + m[0].length,
    attrs: m[1],
    body: m[2],
  }));
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  '<artifact',
  '<ARTIFACT',
  '<Artifact',
  '</artifact>',
  '</ARTIFACT>',
  '<artifactx',
  '</artifact',
  ' ',
  '  ',
  '\n',
  '\r',
  '\t',
  '\u00a0',
  '\u2028',
  '>',
  '"',
  "'",
  '=',
  'a',
  'type="t"',
];

function randomText(rand: () => number): string {
  const len = 1 + Math.floor(rand() * 16);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

function fuzzMismatches(seed: number, compare: (text: string) => boolean): string[] {
  const rand = mulberry32(seed);
  const mismatches: string[] = [];
  for (let i = 0; i < 5000 && mismatches.length < 5; i++) {
    const text = randomText(rand);
    if (!compare(text)) mismatches.push(JSON.stringify(text));
  }
  return mismatches;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// At 10k the old regexes' baseline is already tens to hundreds of ms, the linear scans a few ms.
const GROWTH_SMALL_N = 10_000;
// The old lazy `.*?` grammar is cubic on a closed opener with no closer (tries every later '>'), so
// 1k already puts its baseline near the 500ms ceiling; 10k would stall the suite for minutes.
const CUBIC_SMALL_N = 1_000;

const QUADRATIC_SHAPES: [string, (n: number) => string, number][] = [
  ['repeated unclosed opener', n => '<artifact a '.repeat(n), GROWTH_SMALL_N],
  ['repeated opener with no closer', n => '<artifact a>'.repeat(n), CUBIC_SMALL_N],
  ['one opener then a whitespace run', n => '<artifact' + ' '.repeat(n), GROWTH_SMALL_N],
];

describe('matchArtifactTagBlocks', () => {
  it('matches the old artifactExtractor regex on seeded fuzz input', () => {
    expect(fuzzMismatches(1, t => same(matchArtifactTagBlocks(t), oldBlocks(OLD_EXTRACTOR, t)))).toEqual([]);
  });

  it('keeps attributes on one line and takes the first closer', () => {
    expect(matchArtifactTagBlocks('<artifact a\n>x</artifact>')).toEqual([]);
    expect(matchArtifactTagBlocks('<ARTIFACT \n a="1">x</artifact></artifact>')).toEqual([
      { index: 0, end: 30, attrs: 'a="1"', body: 'x' },
    ]);
  });

  it.each(QUADRATIC_SHAPES)('scans a %s in linear time', (_label, build, small) => {
    expectLinearGrowth(build, matchArtifactTagBlocks, small);
  });
});

describe('stripArtifactTagBlocks', () => {
  it('matches the old markdownGenerator replace on seeded fuzz input', () => {
    expect(fuzzMismatches(2, t => stripArtifactTagBlocks(t) === t.replace(OLD_MARKDOWN, ''))).toEqual([]);
  });

  it.each(QUADRATIC_SHAPES)('strips a %s in linear time', (_label, build, small) => {
    expectLinearGrowth(build, stripArtifactTagBlocks, small);
  });
});

describe('matchToolArtifactTagBlocks', () => {
  it('matches the old sharedToolBuilder regex on seeded fuzz input', () => {
    expect(fuzzMismatches(3, t => same(matchToolArtifactTagBlocks(t), oldBlocks(OLD_TOOL, t)))).toEqual([]);
  });

  it('lets attributes span lines', () => {
    expect(matchToolArtifactTagBlocks('<artifact a\nb>x</artifact>')).toEqual([
      { index: 0, end: 26, attrs: 'a\nb', body: 'x' },
    ]);
  });

  it.each(QUADRATIC_SHAPES)('scans a %s in linear time', (_label, build) => {
    expectLinearGrowth(build, matchToolArtifactTagBlocks, GROWTH_SMALL_N);
  });
});

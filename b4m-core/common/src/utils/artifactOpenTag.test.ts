import { describe, expect, it } from 'vitest';
import { ARTIFACT_ATTRS_PATTERN } from '../types/entities/ArtifactTypes';
import {
  matchArtifactBlocks,
  scanArtifactOpenTag,
  type ArtifactTagLeading,
  type ArtifactTagMemo,
} from './artifactOpenTag';

// The regexes these readers replaced, kept as the differential oracle.
const OLD_TAG: Record<ArtifactTagLeading, RegExp> = {
  one: new RegExp(`<artifact\\s(${ARTIFACT_ATTRS_PATTERN})>`, 'iy'),
  run: new RegExp(`<artifact\\s+(${ARTIFACT_ATTRS_PATTERN})>`, 'iy'),
};
const OLD_BLOCKS = new RegExp(`<artifact\\s+(${ARTIFACT_ATTRS_PATTERN})>([\\s\\S]*?)<\\/artifact>`, 'gi');

function oldTag(text: string, at: number, leading: ArtifactTagLeading) {
  const re = OLD_TAG[leading];
  re.lastIndex = at;
  const m = re.exec(text);
  return m ? { attrs: m[1], end: re.lastIndex } : null;
}

function oldBlocks(content: string) {
  return Array.from(content.matchAll(OLD_BLOCKS), m => ({ index: m.index, fullMatch: m[0], attrs: m[1], body: m[2] }));
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
  ' ',
  '  ',
  '\n',
  '\t',
  '\u00a0',
  '>',
  '"',
  "'",
  '=',
  'a',
  'x',
  'type="t"',
  "id='i'",
];

function randomText(rand: () => number): string {
  const len = 1 + Math.floor(rand() * 14);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

// Best of three with a floored denominator, as in the utils parser's growth tests: a near-
// instant run is timer noise, while a quadratic scan is slow on every attempt.
const MIN_BASELINE_MS = 25;

function bestMs(fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

function expectLinear(build: (n: number) => string, run: (s: string) => unknown) {
  const [ta, tb, tc] = [20_000, 40_000, 80_000].map(n => {
    const input = build(n);
    return bestMs(() => run(input));
  });
  expect(tb / Math.max(ta, MIN_BASELINE_MS)).toBeLessThan(3);
  expect(tc / Math.max(tb, MIN_BASELINE_MS)).toBeLessThan(3);
}

describe('scanArtifactOpenTag', () => {
  it.each(['one', 'run'] as const)('matches the old %s regex at every position of seeded fuzz input', leading => {
    const rand = mulberry32(leading === 'one' ? 1 : 2);
    for (let i = 0; i < 5000; i++) {
      const text = randomText(rand);
      const memo: ArtifactTagMemo = {};
      for (let at = 0; at < text.length; at++) {
        expect(scanArtifactOpenTag(text, at, leading, memo)).toEqual(oldTag(text, at, leading));
      }
    }
  });

  it('reads U+00A0 and newlines as whitespace and skips a quoted >', () => {
    expect(scanArtifactOpenTag('<artifact\u00a0a="x>y">', 0, 'one')).toEqual({ attrs: 'a="x>y"', end: 18 });
    expect(scanArtifactOpenTag('<artifact\n\n a>', 0, 'run')).toEqual({ attrs: 'a', end: 14 });
    expect(scanArtifactOpenTag('<artifact\n\n a>', 0, 'one')).toEqual({ attrs: '\n a', end: 14 });
  });

  it('handles an empty tag, a non-tag word, mixed case and an unclosed quote', () => {
    expect(scanArtifactOpenTag('<artifact >', 0, 'one')).toEqual({ attrs: '', end: 11 });
    expect(scanArtifactOpenTag('<artifactx a>', 0, 'one')).toBeNull();
    expect(scanArtifactOpenTag('<ArTiFaCt a>', 0, 'run')).toEqual({ attrs: 'a', end: 12 });
    expect(scanArtifactOpenTag('<artifact a="x>', 0, 'one')).toBeNull();
  });

  it('lets a later opener inside an unclosed quote win', () => {
    const text = '<artifact a="x <artifact b>';
    expect(scanArtifactOpenTag(text, 0, 'run')).toBeNull();
    expect(scanArtifactOpenTag(text, 15, 'run')).toEqual({ attrs: 'b', end: text.length });
  });

  it.each([
    ['repeated unclosed opener', (n: number) => '<artifact a '.repeat(n)],
    ['repeated closed opener', (n: number) => '<artifact a>'.repeat(n)],
    ['one opener then a whitespace run', (n: number) => '<artifact' + ' '.repeat(n)],
    ['repeated unclosed quote', (n: number) => '<artifact a="'.repeat(n)],
  ])('scans every opener of a %s in linear time', (_label, build) => {
    for (const leading of ['one', 'run'] as const) {
      expectLinear(build, text => {
        const memo: ArtifactTagMemo = {};
        for (let at = text.indexOf('<'); at >= 0; at = text.indexOf('<', at + 1)) {
          scanArtifactOpenTag(text, at, leading, memo);
        }
      });
    }
  });
});

describe('matchArtifactBlocks', () => {
  it('matches the old ARTIFACT_REGEX exec loop on seeded fuzz input', () => {
    const rand = mulberry32(3);
    for (let i = 0; i < 5000; i++) {
      const text = randomText(rand);
      expect(matchArtifactBlocks(text)).toEqual(oldBlocks(text));
    }
  });

  it('reads a block with a quoted closer in its tag and a lazy body', () => {
    const text = 'x<artifact t="</artifact>">one</artifact><ARTIFACT  u>two</Artifact>';
    expect(matchArtifactBlocks(text)).toEqual(oldBlocks(text));
    expect(matchArtifactBlocks(text).map(b => b.body)).toEqual(['one', 'two']);
  });

  it.each([
    ['repeated unclosed opener', (n: number) => '<artifact a '.repeat(n)],
    ['repeated closed opener', (n: number) => '<artifact a>'.repeat(n)],
    ['one opener then a whitespace run', (n: number) => '<artifact' + ' '.repeat(n)],
    ['repeated unclosed quote', (n: number) => '<artifact a="'.repeat(n)],
  ])('runs in linear time on a %s', (_label, build) => {
    expectLinear(build, matchArtifactBlocks);
  });
});

import { describe, expect, it } from 'vitest';
import { matchExplain, matchFormula, matchSetValue, splitEquals } from './intentScan';

// The regexes the scanners replaced, kept as the differential oracle.
const SITES: Array<[string, RegExp, (s: string) => string[] | null]> = [
  ['equals', /^(.+?)\s*(?:=|equals?)\s*(.+)$/i, splitEquals],
  ['set', /(?:set\s+)?(.+?)\s+(?:is|to|=|equals?)\s+\$?([\d,]+(?:\.\d+)?)/i, matchSetValue],
  ['formula', /(.+?)\s*(?:=|equals?)\s*(.+?)\s*([+\-*/])\s*(.+)/i, matchFormula],
  ['explain', /(?:explain|how\s+is)\s+(.+?)(?:\s+calculated)?(?:\?)?$/i, matchExplain],
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
const LEADS = ['', 'set ', 'set  \n ', 'explain ', 'how  is ', 'a = ', 'x equals '];
const TOKENS = [
  'set',
  'is',
  'to',
  '=',
  'equals',
  'equal',
  'Equals',
  '$',
  '1',
  '2,0',
  '.5',
  '.',
  '+',
  '-',
  '*',
  '/',
].concat([
  'explain',
  'how',
  'calculated',
  '?',
  'a',
  'b',
  'revenue',
  ' ',
  ' ',
  ' ',
  '\n',
  '\r',
  '\t',
  ch(0xa0),
  ch(0x2028),
]);
const corpus = (() => {
  const rand = mulberry32(2998);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const cases = ['set    is 5', 'a =   + b', 'a equals+b', 'x equals', 'explain  calculated', 'how is x calculated?'];
  for (let i = 0; i < 3000; i++) {
    let s = pick(LEADS);
    const len = 1 + Math.floor(rand() * 24);
    for (let j = 0; j < len; j++) s += pick(TOKENS);
    cases.push(s, s.trim());
  }
  return cases;
})();

describe('lattice intent scanners', () => {
  it.each(SITES)('%s: yields exactly what the old regex captured across a seeded corpus', (_name, re, scan) => {
    let matched = 0;
    for (const input of corpus) {
      const expected = oldCaptures(re, input);
      if (expected) matched++;
      expect(scan(input), JSON.stringify(input)).toEqual(expected);
    }
    expect(matched).toBeGreaterThan(50);
  });

  it.each(SITES)('%s: control, a greedy near-miss of the regex diverges on the corpus', (_name, re) => {
    const control = new RegExp(re.source.replace('(.+?)', '(.+)'), re.flags);
    expect(corpus.some(s => JSON.stringify(oldCaptures(control, s)) !== JSON.stringify(oldCaptures(re, s)))).toBe(true);
  });

  // Mirrors the assertLinearGrowth helper in b4m-core/utils/src/artifactParser.test.ts.
  function assertLinearGrowth(scan: (s: string) => unknown, build: (n: number) => string, small: number) {
    const measure = (n: number) => {
      const input = build(n);
      const startedAt = performance.now();
      scan(input);
      return performance.now() - startedAt;
    };
    const baselineMs = measure(small);
    expect(baselineMs).toBeLessThan(500);
    expect(measure(small * 2) / Math.max(baselineMs, 5)).toBeLessThan(3);
  }

  // Each shape is one the old regex was quadratic or worse on; at these sizes it took seconds.
  const SHAPES: Array<[string, (s: string) => unknown, (n: number) => string]> = [
    ['equals, spaces', splitEquals, n => 'a' + ' '.repeat(n) + 'x'],
    ['equals, operator run', splitEquals, n => 'a' + '= '.repeat(n) + '\nx'],
    ['set, spaces', matchSetValue, n => 'set a' + ' '.repeat(n) + 'x'],
    ['set, keyword run', matchSetValue, n => 'set a' + ' is'.repeat(n) + '\nx'],
    ['set, space-newlines', matchSetValue, n => 'set a' + ' \n'.repeat(n) + 'x'],
    ['formula, spaces', matchFormula, n => 'a' + ' '.repeat(n) + 'x'],
    ['formula, operator run', matchFormula, n => 'a' + '= '.repeat(n) + '\nx'],
    ['formula, space-newlines', matchFormula, n => 'a' + ' \n'.repeat(n) + 'x'],
    ['explain, spaces', matchExplain, n => 'explain a' + ' '.repeat(n) + 'x'],
    ['set, repeated openers', matchSetValue, n => 'set a '.repeat(n) + '\nx'],
    ['formula, repeated equations', matchFormula, n => 'a=b '.repeat(n) + '\nx'],
    ['explain, repeated openers', matchExplain, n => 'explain a '.repeat(n) + '\nx'],
  ];
  it.each(SHAPES)('stays linear: %s', (_name, scan, build) => {
    assertLinearGrowth(scan, build, 20_000);
  });
});

import { describe, expect, it } from 'vitest';
import {
  ResultReplacer,
  replaceDirectTypeObjects,
  replaceEscapedResultObjects,
  replaceLazyResultObjects,
  replaceLogFormatResultObjects,
} from './toolOutputResultScan';

// The regexes these scanners replaced in convertToolOutputsToArtifacts.
const OLD_P1 = /"result":\s*"(\{\\?"[^"]*\\?":\s*\\?"[^"]*\\?"[^}]*\})"/g;
const OLD_P3 = /"result":\s*"(\{.*?\})"/g;
const OLD_P4 = /(\{[^{}]*"type"\s*:\s*"(?:rechart|recharts|mermaid)"[^{}]*\})/g;
const OLD_P5 = /"result":\s*"\{(\\\\"type\\\\":\\\\"(?:rechart|recharts|mermaid)\\\\"[^}]*)\}"/g;

type Scan = (text: string, replacer: ResultReplacer) => string;

const CASES: Array<[string, RegExp, Scan]> = [
  ['pattern 1', OLD_P1, replaceEscapedResultObjects],
  ['pattern 3', OLD_P3, replaceLazyResultObjects],
  ['pattern 4', OLD_P4, replaceDirectTypeObjects],
  ['pattern 5', OLD_P5, replaceLogFormatResultObjects],
];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ESCAPED_TYPE = '\\\\"type\\\\":\\\\"';
const ALPHABET = [
  '"result":',
  '"result": "{',
  '"result":"{',
  ' ',
  '\n',
  '\r',
  '\u2028',
  '"',
  '{',
  '}',
  '}"',
  '\\',
  '\\"',
  '\\\\"',
  ':',
  'x',
  '{"a":"b"',
  '{\\"a\\": \\"b\\"',
  ESCAPED_TYPE,
  'mermaid',
  '"type":"mermaid"',
  '"type" :\n "recharts"',
  '"type":',
  '"type"',
  'rechart',
  'recharts',
  'mermaid\\\\"',
  'rechart\\\\"',
  '"result":"{"a":"b"',
  `"result":"{${ESCAPED_TYPE}`,
  `"result": "{${ESCAPED_TYPE}recharts\\\\"`,
];

function randomText(rand: () => number): string {
  const len = 1 + Math.floor(rand() * 14);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

// Records every call and substitutes its ordinal, so equal outputs also mean equal offsets.
function run(scan: (replacer: ResultReplacer) => string) {
  const calls: Array<[string, string]> = [];
  const output = scan((match, captured) => {
    calls.push([match, captured]);
    return `<#${calls.length}>`;
  });
  return { output, calls };
}

// Same shape and constants as assertLinearGrowth in b4m-core/utils/src/artifactParser.test.ts.
// Each case's `small` keeps the scanner a few ms at 2x, far under the floored ~75ms budget,
// while the old regex's baseline on the unclosed shapes is already hundreds of ms.
const MIN_BASELINE_MS = 25;
const GROWTH_RATIO_CEILING = 3;
const SMALL_INPUT_MS_CEILING = 500;

function bestOfThreeMs(input: string, scan: Scan): number {
  let best = Infinity;
  for (let attempt = 0; attempt < 3; attempt++) {
    const startedAt = performance.now();
    scan(input, match => match);
    best = Math.min(best, performance.now() - startedAt);
  }
  return best;
}

function expectLinearGrowth(build: (n: number) => string, scan: Scan, small: number) {
  const baselineMs = bestOfThreeMs(build(small), scan);
  expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
  const doubledMs = bestOfThreeMs(build(small * 2), scan);
  expect(doubledMs / Math.max(baselineMs, MIN_BASELINE_MS)).toBeLessThan(GROWTH_RATIO_CEILING);
}

describe('tool-output result scanners', () => {
  it.each(CASES)('%s agrees with the old regex on seeded random input', (_label, oldRegex, scan) => {
    const rand = mulberry32(11);
    let matched = 0;
    for (let i = 0; i < 5000; i++) {
      const text = randomText(rand);
      const expected = run(replacer => text.replace(oldRegex, replacer));
      expect(
        run(replacer => scan(text, replacer)),
        JSON.stringify(text)
      ).toEqual(expected);
      matched += expected.calls.length;
    }
    expect(matched).toBeGreaterThan(50);
  });

  it('pattern 3 skips a result object broken by a line terminator', () => {
    const text = '"result":"{a\nb}" "result":"{"ok":1}"';
    expect(run(r => replaceLazyResultObjects(text, r)).calls).toEqual([['"result":"{"ok":1}"', '{"ok":1}']]);
  });

  it('pattern 5 captures the body between the braces', () => {
    const text = `"result":"{${ESCAPED_TYPE}mermaid\\\\",x}"`;
    expect(run(r => replaceLogFormatResultObjects(text, r)).calls).toEqual([[text, `${ESCAPED_TYPE}mermaid\\\\",x`]]);
  });

  it('pattern 4 takes only an innermost object', () => {
    const text = '{"a":{"type" : "mermaid","b":1},"type":"rechart"}';
    expect(run(r => replaceDirectTypeObjects(text, r)).calls).toEqual([
      ['{"type" : "mermaid","b":1}', '{"type" : "mermaid","b":1}'],
    ]);
  });

  it.each<[string, (n: number) => string, Scan, number]>([
    ['pattern 1 on repeated prefixes', n => '"result":"{"a":"b"'.repeat(n), replaceEscapedResultObjects, 10_000],
    ['pattern 3 on repeated unclosed objects', n => '"result":"{x'.repeat(n), replaceLazyResultObjects, 10_000],
    [
      'pattern 4 on repeated types in an unclosed object',
      n => '{' + '"type":"mermaid"'.repeat(n),
      replaceDirectTypeObjects,
      5_000,
    ],
    ['pattern 4 on repeated closed objects', n => '{"type":"mermaid"}{x'.repeat(n), replaceDirectTypeObjects, 5_000],
    [
      'pattern 5 on repeated escaped mermaid prefixes',
      n => `"result":"{${ESCAPED_TYPE}mermaid\\\\"`.repeat(n),
      replaceLogFormatResultObjects,
      5_000,
    ],
  ])('scans %s in linear time', (_label, build, scan, small) => {
    expectLinearGrowth(build, scan, small);
  });
});

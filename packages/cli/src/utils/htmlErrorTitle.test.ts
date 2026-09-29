import { describe, expect, it } from 'vitest';
import { htmlBodyInner, htmlErrorTitle, htmlFirstH1, replaceHtmlTags } from './htmlErrorTitle.js';

// The inline regex form this helper replaced in Logger.parseHtmlError and ServerLlmBackend.
function oldHtmlErrorTitle(html: string): string | null {
  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  return titleMatch && titleMatch[1] !== 'Error' ? titleMatch[1].trim() : null;
}

const oldFirstH1 = (html: string) => html.match(/<h1>(.*?)<\/h1>/i)?.[1] ?? null;
const oldBodyInner = (html: string) => html.match(/<body[^>]*>(.*?)<\/body>/is)?.[1] ?? null;
const oldReplaceTags = (text: string) => text.replace(/<[^>]+>/g, ' ');

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ['<title>', '</title>', '<TITLE>', '</Title>', 'Error', ' ', 'x', '\n', '\r', '\u2028', '<', '/'];

// Same best-of-3 and floored baseline as assertLinearGrowth in b4m-core/utils/src/artifactParser.test.ts,
// but measured n against 4n with an 8x ceiling: linear lands near 4x and quadratic near 16x, so
// CI runner noise cannot push one across the bound the way it could at 2x against 3x.
const MIN_BASELINE_MS = 25;
const GROWTH_RATIO_CEILING = 8;
const SMALL_INPUT_MS_CEILING = 500;

function bestOfThreeMs(input: string, scan: (text: string) => unknown = htmlErrorTitle): number {
  let best = Infinity;
  for (let attempt = 0; attempt < 3; attempt++) {
    const startedAt = performance.now();
    scan(input);
    best = Math.min(best, performance.now() - startedAt);
  }
  return best;
}

describe('htmlErrorTitle', () => {
  it('agrees with the old regex on seeded random input', () => {
    const rand = mulberry32(5);
    let found = 0;
    for (let i = 0; i < 5000; i++) {
      let text = '';
      const len = 1 + Math.floor(rand() * 12);
      for (let j = 0; j < len; j++) text += ALPHABET[Math.floor(rand() * ALPHABET.length)];
      const expected = oldHtmlErrorTitle(text);
      expect(htmlErrorTitle(text), JSON.stringify(text)).toBe(expected);
      if (expected !== null) found++;
    }
    expect(found).toBeGreaterThan(50);
  });

  it('skips a bare "Error" title and trims the rest', () => {
    expect(htmlErrorTitle('<html><title>Error</title></html>')).toBeNull();
    expect(htmlErrorTitle('<html><TITLE> 502 Bad Gateway </TITLE></html>')).toBe('502 Bad Gateway');
  });

  it('reads repeated unclosed openers in linear time', () => {
    const build = (n: number) => '<!DOCTYPE html>' + '<title>'.repeat(n);
    const baselineMs = bestOfThreeMs(build(8_000));
    expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
    const quadrupledMs = bestOfThreeMs(build(32_000));
    expect(quadrupledMs / Math.max(baselineMs, MIN_BASELINE_MS)).toBeLessThan(GROWTH_RATIO_CEILING);
  });
});

function expectLinearGrowth(scan: (text: string) => unknown, build: (n: number) => string): void {
  const baselineMs = bestOfThreeMs(build(8_000), scan);
  expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
  const quadrupledMs = bestOfThreeMs(build(32_000), scan);
  expect(quadrupledMs / Math.max(baselineMs, MIN_BASELINE_MS)).toBeLessThan(GROWTH_RATIO_CEILING);
}

function randomText(rand: () => number, alphabet: string[]): string {
  let text = '';
  const len = 1 + Math.floor(rand() * 12);
  for (let j = 0; j < len; j++) text += alphabet[Math.floor(rand() * alphabet.length)];
  return text;
}

const TAG_ALPHABET = [
  '<h1>',
  '</h1>',
  '<H1>',
  '</H1>',
  '<body',
  '<BODY',
  '</body>',
  '</Body>',
  '>',
  '<',
  'a',
  ' ',
  '\n',
  '\r',
  '\u2028',
  '\u2029',
];

describe.each([
  ['htmlFirstH1', htmlFirstH1, oldFirstH1],
  ['htmlBodyInner', htmlBodyInner, oldBodyInner],
  ['replaceHtmlTags', replaceHtmlTags, oldReplaceTags],
] as const)('%s', (_name, scan, oldScan) => {
  it('agrees with the old regex on seeded random input', () => {
    const rand = mulberry32(11);
    for (let i = 0; i < 5000; i++) {
      const text = randomText(rand, TAG_ALPHABET);
      expect(scan(text), JSON.stringify(text)).toBe(oldScan(text));
    }
  });
});

describe('html error scans run in linear time', () => {
  it.each([
    ['h1 openers', htmlFirstH1, (n: number) => '<html>' + '<h1>'.repeat(n)],
    ['h1 split by newlines', htmlFirstH1, (n: number) => '<html></h1>' + '<h1>x\n'.repeat(n) + '</h1>'],
    ['body openers', htmlBodyInner, (n: number) => '<html>' + '<body>'.repeat(n)],
    ['body with no tag end', htmlBodyInner, (n: number) => '<html>' + '<body'.repeat(n)],
    ['unclosed tag starts', replaceHtmlTags, (n: number) => '<'.repeat(4 * n)],
  ] as const)('%s', (_name, scan, build) => {
    expectLinearGrowth(scan, build);
  });
});

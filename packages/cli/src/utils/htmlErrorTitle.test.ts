import { describe, expect, it } from 'vitest';
import { htmlErrorTitle } from './htmlErrorTitle.js';

// The inline regex form this helper replaced in Logger.parseHtmlError and ServerLlmBackend.
function oldHtmlErrorTitle(html: string): string | null {
  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  return titleMatch && titleMatch[1] !== 'Error' ? titleMatch[1].trim() : null;
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

const ALPHABET = ['<title>', '</title>', '<TITLE>', '</Title>', 'Error', ' ', 'x', '\n', '\r', '\u2028', '<', '/'];

// Same shape and constants as assertLinearGrowth in b4m-core/utils/src/artifactParser.test.ts.
const MIN_BASELINE_MS = 25;
const GROWTH_RATIO_CEILING = 3;
const SMALL_INPUT_MS_CEILING = 500;

function bestOfThreeMs(input: string): number {
  let best = Infinity;
  for (let attempt = 0; attempt < 3; attempt++) {
    const startedAt = performance.now();
    htmlErrorTitle(input);
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
    const doubledMs = bestOfThreeMs(build(16_000));
    expect(doubledMs / Math.max(baselineMs, MIN_BASELINE_MS)).toBeLessThan(GROWTH_RATIO_CEILING);
  });
});

import { describe, it, expect } from 'vitest';
import { parseToolArgsLenient } from './ReActAgent';

// Same shape as the regex-linearity helpers in b4m-core/services/src/__tests__/utils/regexLinearity.ts.
const OLD_FENCE = /^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/;
const NEW_FENCE = /^```(?:json|JSON)?([\s\S]*?)```$/;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function trimmed(re: RegExp, s: string) {
  const m = s.match(re);
  return m ? [m.index, m.index! + m[0].length, m[1].trim()] : null;
}

describe('parseToolArgsLenient - code fence regex', () => {
  it('matches the old regex on every seeded input once the capture is trimmed', () => {
    const rand = lcg(2998);
    const pieces = ['```', '```json', '```JSON', ' ', '\n', '\t', '\r', '{"a":1}', 'x', '`'];
    const wrap: (s: string) => string = s => '```' + s;
    const corpus = Array.from({ length: 3000 }, () =>
      wrap(
        Array.from({ length: 1 + Math.floor(rand() * 12) }, () => pieces[Math.floor(rand() * pieces.length)]).join('')
      )
    );
    expect(corpus.filter(s => NEW_FENCE.test(s)).length).toBeGreaterThan(50);
    expect(corpus.filter(s => JSON.stringify(trimmed(OLD_FENCE, s)) !== JSON.stringify(trimmed(NEW_FENCE, s)))).toEqual(
      []
    );
  });

  // The old prefix was quadratic on an unclosed fence: about 700ms at n=32000.
  it('stays linear on an unclosed fence followed by whitespace', () => {
    const run: (s: string) => unknown = s => {
      try {
        parseToolArgsLenient(s);
      } catch {
        /* unparseable by design */
      }
    };
    // Same sampling as measureGrowth in b4m-core/services/src/__tests__/utils/regexLinearity.ts: the
    // first run is the warm-up, and each size keeps its fastest of five runs so a single GC pause or
    // noisy-neighbor stall on a shared CI runner cannot fake a super-linear ratio.
    const time = (input: string) => {
      const startedAt = performance.now();
      run(input);
      return performance.now() - startedAt;
    };
    const baselineInput = '```json' + ' \n'.repeat(32000) + 'x';
    let baselineMs = time(baselineInput);
    expect(baselineMs).toBeLessThan(500);
    for (let i = 1; i < 5; i++) baselineMs = Math.min(baselineMs, time(baselineInput));
    const doubledInput = '```json' + ' \n'.repeat(64000) + 'x';
    let ratio = Infinity;
    for (let i = 0; i < 5 && ratio >= 3; i++) ratio = Math.min(ratio, time(doubledInput) / Math.max(baselineMs, 5));
    expect(ratio).toBeLessThan(3);
  });
});

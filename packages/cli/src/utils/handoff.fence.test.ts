import { describe, it, expect } from 'vitest';
import { parseHandoffResponse } from './handoff.js';

// Same shape as the regex-linearity helpers in b4m-core/services/src/__tests__/utils/regexLinearity.ts.
const OLD_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;
const NEW_FENCE = /```(?:json)?([\s\S]*?)```/i;

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

describe('parseHandoffResponse - code fence regex', () => {
  it('matches the old regex on every seeded input once the capture is trimmed', () => {
    const rand = lcg(2998);
    const pieces = ['```', '```json', '```JSON', ' ', '\n', '\t', '\r', '{"a":1}', 'x', '`'];
    const wrap: (s: string) => string = s => s;
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

  // The old prefix was quadratic on an unclosed fence: about 200ms at n=64000, four times that when doubled.
  it('stays linear on an unclosed fence followed by whitespace', () => {
    const run: (s: string) => unknown = parseHandoffResponse;
    const time = (n: number) => {
      const input = '```json' + '\n'.repeat(n) + 'x';
      const startedAt = performance.now();
      run(input);
      return performance.now() - startedAt;
    };
    const baselineMs = time(64000);
    expect(baselineMs).toBeLessThan(500);
    expect(time(64000 * 2) / Math.max(baselineMs, 5)).toBeLessThan(3);
  });
});

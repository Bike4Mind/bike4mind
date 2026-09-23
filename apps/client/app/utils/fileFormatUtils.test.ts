// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { detectFileFormat, MARKDOWN_BULLET_PROBE } from './fileFormatUtils';

/**
 * detectMarkdown's bullet-list probe. Reachable from a model reply's fenced code block through
 * replyDownloads, so the input is attacker-shaped text, not a file the user picked.
 *
 * Verbatim pre-change pattern: `\s*` under /m let the leading run swallow line terminators, so a
 * blank-line-heavy input rescanned to the end from every line start (quadratic). /m re-anchors ^
 * after every terminator, so a run that crossed one only re-reached a position ^ matches anyway -
 * which is why narrowing the run cannot change the predicate.
 */
const ORIGINAL_BULLET = /^\s*[-*+]\s/m;
// The shipped pattern itself, not a copy: a copy would keep every case below passing after the
// real probe was narrowed, which is exactly the regression the mutation control claims to catch.
const CURRENT_BULLET = MARKDOWN_BULLET_PROBE;

/** Deterministic LCG (Numerical Recipes constants) so CI generates the identical corpus every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const BULLET_CORPUS: readonly string[] = (() => {
  const WS_CHARS = ['', ' ', '  ', '\t', '\f', '\v', '\u00a0', '\ufeff', '\u3000', ' \t'];
  const TERMS = ['\n', '\r', '\r\n', '\u2028', '\u2029'];
  const BODIES = ['- item', '* item', '+ item', '-item', '- ', '-', 'a - b', '# head', '**b**', 'x', '', '-\ty'];
  const rand = lcg(0xb0115);
  const pick = (a: readonly string[]): string => a[Math.floor(rand() * a.length)];
  const cases: string[] = [];
  for (let i = 0; i < 6000; i++) {
    const n = 1 + Math.floor(rand() * 4);
    let text = pick(WS_CHARS) + pick(BODIES);
    for (let j = 1; j < n; j++) text += pick(TERMS) + pick(WS_CHARS) + pick(BODIES);
    cases.push(text);
  }
  return cases;
})();

describe('detectMarkdown bullet probe: leading-whitespace run', () => {
  it('agrees with the original /^\\s*[-*+]\\s/m on every whitespace and terminator shape', () => {
    const diffs = BULLET_CORPUS.filter(s => CURRENT_BULLET.test(s) !== ORIGINAL_BULLET.test(s));
    expect({ count: diffs.length, examples: diffs.slice(0, 5).map(s => JSON.stringify(s)) }).toEqual({
      count: 0,
      examples: [],
    });
  });

  it('is not vacuous: the corpus both matches and rejects in bulk', () => {
    const matched = BULLET_CORPUS.filter(s => CURRENT_BULLET.test(s)).length;
    expect(matched).toBeGreaterThan(500);
    expect(BULLET_CORPUS.length - matched).toBeGreaterThan(500);
  });

  it('mutation control: a run narrowed to [ \\t] disagrees with the original', () => {
    const narrowed = /^[ \t]*[-*+]\s/m; // the tempting fix; drops the form feed, vertical tab and NBSP
    expect(BULLET_CORPUS.filter(s => narrowed.test(s) !== ORIGINAL_BULLET.test(s)).length).toBeGreaterThan(0);
  });

  it('still reads an indented bullet list as markdown end to end', () => {
    // 0.3 header + 0.2 bold + 0.2 bullets clears detectMarkdown's 0.6 bar; drop the bullets and it
    // does not, so this case is load-bearing on the probe under test.
    const bullets = '# Title\n\nsome **bold** text\n\u00a0- one\n\f* two\n+ three\n';
    expect(detectFileFormat(bullets).extension).toBe('md');
    expect(detectFileFormat('# Title\n\nsome **bold** text\n').extension).not.toBe('md');
  });
});

// Ceiling-first near-linear-scaling guard, as in the publish transpiler's suite: a fixed budget
// only fails after the synchronous scan returns, so a quadratic regression would wedge the CI
// shard for minutes instead of failing. `small` is chosen so the pre-change pattern blows the
// ceiling on the FIRST measurement (it cost 0.45s at 32768 bare terminators, 11s at 160k).
const MIN_BASELINE_MS = 25;
const GROWTH_RATIO_CEILING = 3;
const SMALL_INPUT_MS_CEILING = 250;

function assertLinearGrowth(build: (n: number) => string, small: number, run: (input: string) => unknown): void {
  // Best of three: a GC pause in one window is worth more than the whole budget here, while a
  // genuinely super-linear scan is slow on every attempt.
  const measure = (n: number): number => {
    const input = build(n);
    let bestMs = Infinity;
    for (let attempt = 0; attempt < 3; attempt++) {
      const startedAt = performance.now();
      run(input);
      bestMs = Math.min(bestMs, performance.now() - startedAt);
    }
    return bestMs;
  };
  const baselineMs = measure(small);
  expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
  const doubledMs = measure(small * 2);
  expect(doubledMs / Math.max(baselineMs, MIN_BASELINE_MS)).toBeLessThan(GROWTH_RATIO_CEILING);
}

describe('detectFileFormat scales linearly on a blank-line-heavy markdown-ish reply', () => {
  const TERMINATORS: readonly [string, string][] = [
    ['LF', '\n'],
    ['CR', '\r'],
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029'],
  ];
  // The `#` is what gets past detectMarkdown's cheap pre-check, so the bullet probe actually runs;
  // the head and tail keep `.trim()` from eating the terminator run.
  for (const [label, term] of TERMINATORS) {
    it(`stays near-linear on a reply padded with bare ${label} line terminators`, () => {
      assertLinearGrowth(n => '# h' + term.repeat(n) + 'x', 32768, detectFileFormat);
    });
  }
});

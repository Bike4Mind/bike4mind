import { describe, it, expect } from 'vitest';
import { tryParseChartJSON } from './chartJsonParser';

// Mirrors the assertLinearGrowth helper in b4m-core/utils/src/artifactParser.test.ts:
// the baseline-vs-ceiling check is the real regression guard (fails fast instead of
// letting a catastrophic-backtracking regex hang the runner); the ratio check is
// secondary. See that file for the full rationale.
const MIN_BASELINE_MS = 5;
const GROWTH_RATIO_CEILING = 3;
const SMALL_INPUT_MS_CEILING = 500;

function assertLinearGrowth(build: (n: number) => string, small: number) {
  const measure = (n: number) => {
    const input = build(n);
    const startedAt = performance.now();
    tryParseChartJSON(input);
    return performance.now() - startedAt;
  };

  const baselineMs = measure(small);
  expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);

  const doubledMs = measure(small * 2);
  const ratio = doubledMs / Math.max(baselineMs, MIN_BASELINE_MS);
  expect(ratio).toBeLessThan(GROWTH_RATIO_CEILING);
}

describe('chartJsonParser - code fence regex growth', () => {
  it('stays linear on an unclosed ```recharts fence followed by a run of newlines', () => {
    // The old fence regex (/```(?:json|recharts)?\s*\n?([\s\S]*?)\n?\s*```/) was cubic
    // on this shape: three overlapping whitespace consumers backtrack against the run
    // of newlines when no closing fence is ever found.
    // The trailing 'x' is what makes the shape reach that regex at all: the parser trims
    // its input first, so a run of pure whitespace collapses to the bare fence opener and
    // costs nothing at any n - without a non-whitespace tail this pins nothing.
    // n is sized so the pre-fix cost clears the 500ms ceiling with room to spare while
    // staying far inside the 30s testTimeout: measured against the old pattern at n=1200,
    // 1149-1211ms per call, against 0.7-0.8ms now. The ceiling assertion fires before the
    // doubled measurement, so time-to-failure is that one call; even if both ran, the
    // doubled call adds ~9.5s and the test still finishes inside the timeout.
    assertLinearGrowth(n => '```recharts\n' + '\n'.repeat(n) + 'x', 1200);
  });

  it('stays linear on an unclosed ```json fence with trailing spaces per line', () => {
    // Same trim-survival requirement and the same sizing rule as above; this shape costs
    // more per character, so n is lower. Pre-fix at n=700: 932-1540ms per call (the
    // doubled call would add ~9.2s if the ceiling ever let it run), against 0.8ms now.
    assertLinearGrowth(n => '```json\n' + ' \n'.repeat(n) + 'x', 700);
  });

  it('stays linear on an unclosed ```json fence padded with spaces and no newline', () => {
    // The newline-bearing cases above never reached the horizontal-whitespace consumer
    // that used to sit before the body: only a run with no newline in it made that
    // consumer give back one character at a time, rescanning to end on each step.
    // n must clear the 500ms ceiling on the pre-fix regex without letting a regression
    // hang past the test timeout: the ceiling check runs only after measure(small)
    // returns, and the parser blocks the single JS thread, so vitest's testTimeout
    // cannot preempt it mid-measure. Measured directly against the old pattern
    // (/```(?:json|recharts)?\s*\n?([\s\S]*?)\n?\s*```/) at n=2500: median 2763ms
    // (runs 3121/2763/2664ms) - well over the ceiling, but seconds, not hours.
    assertLinearGrowth(n => '```json' + ' '.repeat(n) + 'x', 2500);
  });
});

describe('chartJsonParser - fence extraction correctness', () => {
  it('parses a ```recharts fence with a trailing newline before the closer', () => {
    const input = '```recharts\n{"chartType":"BarChart","data":[{"x":1,"y":2}]}\n```';
    expect(tryParseChartJSON(input)).toEqual({ chartType: 'BarChart', data: [{ x: 1, y: 2 }] });
  });

  it('parses a ```json fence with no trailing newline before the closer', () => {
    const input = '```json\n{"chartType":"LineChart","data":[{"x":1,"y":2}]}```';
    expect(tryParseChartJSON(input)).toEqual({ chartType: 'LineChart', data: [{ x: 1, y: 2 }] });
  });

  it('parses a bare ``` fence (no json/recharts tag)', () => {
    const input = '```\n{"chartType":"PieChart","data":[{"x":1,"y":2}]}\n```';
    expect(tryParseChartJSON(input)).toEqual({ chartType: 'PieChart', data: [{ x: 1, y: 2 }] });
  });

  it('parses a fence with leading/trailing spaces around the body', () => {
    const input = '```recharts   \n   {"chartType":"BarChart","data":[{"x":1,"y":2}]}   \n   ```';
    expect(tryParseChartJSON(input)).toEqual({ chartType: 'BarChart', data: [{ x: 1, y: 2 }] });
  });

  it('parses a fence with CRLF line endings', () => {
    const input = '```recharts\r\n{"chartType":"BarChart","data":[{"x":1,"y":2}]}\r\n```';
    expect(tryParseChartJSON(input)).toEqual({ chartType: 'BarChart', data: [{ x: 1, y: 2 }] });
  });

  it('parses a fence embedded in surrounding prose', () => {
    const input =
      'Here is your chart:\n```recharts\n{"chartType":"BarChart","data":[{"x":1,"y":2}]}\n```\nHope that helps!';
    expect(tryParseChartJSON(input)).toEqual({ chartType: 'BarChart', data: [{ x: 1, y: 2 }] });
  });

  it('parses a fence body containing an internal blank line', () => {
    const input = '```json\n\n{"chartType":"BarChart","data":[{"x":1,"y":2}]}\n\n```';
    expect(tryParseChartJSON(input)).toEqual({ chartType: 'BarChart', data: [{ x: 1, y: 2 }] });
  });

  it('returns null for an unclosed fence with no valid JSON body', () => {
    const input = '```recharts\nnot json at all';
    expect(tryParseChartJSON(input)).toBeNull();
  });

  it('returns null for an empty fence body', () => {
    const input = '```recharts\n\n```';
    expect(tryParseChartJSON(input)).toBeNull();
  });
});

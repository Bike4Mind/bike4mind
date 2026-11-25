// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { findSlow, formatSlowReport, formatSlowSummaryMarkdown, SLOW_FILE_MS, SLOW_TEST_MS } from './vitest.slowTests';

const file = (name: string, durationMs: number, tests: [string, number][] = []) => ({
  file: name,
  durationMs,
  tests: tests.map(([testName, testMs]) => ({ name: testName, durationMs: testMs })),
});

describe('findSlow', () => {
  it('flags only what is over a budget, slowest first', () => {
    const report = findSlow([
      file('a.test.ts', SLOW_FILE_MS, [['at the limit', SLOW_TEST_MS]]),
      file('b.test.ts', SLOW_FILE_MS + 1, [
        ['slow', 700],
        ['slower', 900],
        ['fast', 20],
      ]),
      file('c.test.ts', 9_000),
    ]);

    expect(report.files.map(entry => entry.file)).toEqual(['c.test.ts', 'b.test.ts']);
    expect(report.tests).toEqual([
      { file: 'b.test.ts', name: 'slower', durationMs: 900 },
      { file: 'b.test.ts', name: 'slow', durationMs: 700 },
    ]);
  });
});

describe('slow report output', () => {
  it('prints nothing when every test is within budget', () => {
    const report = findSlow([file('a.test.ts', 100, [['fast', 10]])]);
    expect(formatSlowReport(report)).toEqual([]);
    expect(formatSlowSummaryMarkdown(report)).toBe('');
  });

  it('caps the listed tests and says how many were left out', () => {
    const tests = Array.from({ length: 35 }, (_, index): [string, number] => [`t${index}`, 600 + index]);
    const lines = formatSlowReport(findSlow([file('a.test.ts', 100, tests)]));

    expect(lines[0]).toBe('Slow tests: 0 file(s) over 5.0s, 35 test(s) over 500ms');
    expect(lines.filter(line => line.startsWith('  test'))).toHaveLength(30);
    expect(lines.at(-1)).toBe('  ... and 5 more test(s)');
  });

  it('keeps a pipe in a test name from breaking the summary table', () => {
    const markdown = formatSlowSummaryMarkdown(findSlow([file('a.test.ts', 6_000, [['a | b', 800]])]));
    expect(markdown).toContain('| `a.test.ts` | 6.0s |');
    expect(markdown).toContain('a \\| b | 800ms |');
  });
});

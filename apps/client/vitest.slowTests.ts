import { appendFileSync } from 'node:fs';
import type { Reporter, TestModule } from 'vitest/node';

// The unit-test budget: a test over 500ms or a file over 5s of test time gets flagged, never failed.
// Timings swing with runner load, so a hard gate here would be a flake source.
export const SLOW_TEST_MS = 500;
export const SLOW_FILE_MS = 5_000;

const LISTED_TESTS = 30;

export type TimedFile = { file: string; durationMs: number; tests: { name: string; durationMs: number }[] };
export type SlowTest = { file: string; name: string; durationMs: number };
export type SlowReport = { files: { file: string; durationMs: number }[]; tests: SlowTest[] };

export function findSlow(timed: TimedFile[]): SlowReport {
  const files = timed
    .filter(entry => entry.durationMs > SLOW_FILE_MS)
    .map(({ file, durationMs }) => ({ file, durationMs }))
    .sort((a, b) => b.durationMs - a.durationMs);
  const tests = timed
    .flatMap(entry => entry.tests.map(test => ({ file: entry.file, ...test })))
    .filter(test => test.durationMs > SLOW_TEST_MS)
    .sort((a, b) => b.durationMs - a.durationMs);
  return { files, tests };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function formatSlowReport({ files, tests }: SlowReport): string[] {
  if (files.length === 0 && tests.length === 0) return [];
  const lines = [
    `Slow tests: ${files.length} file(s) over ${seconds(SLOW_FILE_MS)}, ${tests.length} test(s) over ${SLOW_TEST_MS}ms`,
  ];
  for (const { file, durationMs } of files) lines.push(`  file ${seconds(durationMs).padStart(6)}  ${file}`);
  for (const { file, name, durationMs } of tests.slice(0, LISTED_TESTS)) {
    lines.push(`  test ${`${Math.round(durationMs)}ms`.padStart(6)}  ${file} > ${name}`);
  }
  if (tests.length > LISTED_TESTS) lines.push(`  ... and ${tests.length - LISTED_TESTS} more test(s)`);
  return lines;
}

export function formatSlowSummaryMarkdown({ files, tests }: SlowReport): string {
  if (files.length === 0 && tests.length === 0) return '';
  const cell = (text: string) => text.replace(/\|/g, '\\|');
  const out = [
    `### Slow unit tests`,
    '',
    `${files.length} file(s) over ${seconds(SLOW_FILE_MS)} and ${tests.length} test(s) over ${SLOW_TEST_MS}ms. Flagged, not failed.`,
    '',
  ];
  if (files.length) {
    out.push('| File | Test time |', '|---|---|');
    for (const { file, durationMs } of files) out.push(`| \`${cell(file)}\` | ${seconds(durationMs)} |`);
    out.push('');
  }
  if (tests.length) {
    out.push('| Test | Time |', '|---|---|');
    for (const { file, name, durationMs } of tests.slice(0, LISTED_TESTS)) {
      out.push(`| \`${cell(file)}\` ${cell(name)} | ${Math.round(durationMs)}ms |`);
    }
    if (tests.length > LISTED_TESTS) out.push(`| ... and ${tests.length - LISTED_TESTS} more | |`);
    out.push('');
  }
  return out.join('\n');
}

function timeModule(module: TestModule): TimedFile {
  const tests = [...module.children.allTests()].map(test => ({
    name: test.fullName,
    durationMs: test.diagnostic()?.duration ?? 0,
  }));
  return { file: module.relativeModuleId, durationMs: module.diagnostic().duration, tests };
}

export class SlowTestReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
    const report = findSlow(testModules.map(timeModule));
    const lines = formatSlowReport(report);
    if (lines.length === 0) return;
    console.log(`\n${lines.join('\n')}\n`);

    if (!process.env.GITHUB_ACTIONS) return;
    // One annotation, not one per test: GitHub shows only the first ten from a step.
    console.log(`::warning title=Slow unit tests::${lines[0]}. See the job summary for the list.`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${formatSlowSummaryMarkdown(report)}\n`);
    }
  }
}

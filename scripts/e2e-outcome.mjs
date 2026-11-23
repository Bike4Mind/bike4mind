import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function summarize(report, { execution = 'skipped', skipped = false, cancelled = false, job = 'success' } = {}) {
  const counts = { passed: 0, flaky: 0, failed: 0, skipped: 0, not_started: 0, executed: 0, total: 0, setup_failed: 0 };
  const lines = [];
  function walk(suite, setup, local) {
    setup ||= /\.setup\.[cm]?[jt]s$/.test(suite.file ?? suite.title ?? '');
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results ?? [];
        const ran = results.some(r => r.status !== 'skipped');
        const failed = test.status === 'unexpected' || results.at(-1)?.status === 'interrupted';
        if (setup) {
          if (failed) counts.setup_failed++;
          continue;
        }
        const bucket = !ran
          ? test.status === 'skipped' || results.length
            ? 'skipped'
            : 'not_started'
          : failed
            ? 'failed'
            : test.status === 'expected' || test.status === 'flaky'
              ? 'passed'
              : 'not_started';
        counts[bucket]++;
        if (bucket === 'passed' && test.status === 'flaky') counts.flaky++;
        local[bucket]++;
        counts.total++;
        if (ran) counts.executed++;
      }
    }
    for (const child of suite.suites ?? []) walk(child, setup, local);
  }
  for (const suite of report?.suites ?? []) {
    const local = { passed: 0, failed: 0, skipped: 0, not_started: 0 };
    walk(suite, false, local);
    if (Object.values(local).some(Boolean)) {
      lines.push(
        `${suite.title}: ${local.passed} passed, ${local.failed} failed, ${local.skipped} skipped, ${local.not_started} not started`
      );
    }
  }
  let outcome;
  if (cancelled || execution === 'cancelled') outcome = 'cancelled';
  else if (skipped) outcome = 'skipped';
  else if (counts.setup_failed || report?.errors?.length || (!report && (execution !== 'skipped' || job === 'failure')))
    outcome = 'setup_failed';
  else if (counts.failed) outcome = 'failed';
  else if (execution === 'skipped') outcome = 'not_run';
  else if (counts.executed === 0) outcome = 'no_tests';
  else if (execution === 'failure') outcome = 'failed';
  else if (counts.not_started) outcome = 'incomplete';
  else outcome = 'passed';
  const labels = {
    passed: 'Passed',
    failed: 'Failed',
    skipped: 'Skipped (preview E2E unavailable)',
    cancelled: 'Cancelled',
    setup_failed: 'Setup/deployment failed',
    not_run: 'Not run',
    no_tests: 'No tests executed',
    incomplete: 'Incomplete',
  };
  return {
    ...counts,
    outcome,
    label: labels[outcome],
    state: outcome === 'passed' ? 'success' : ['failed', 'incomplete'].includes(outcome) ? 'failure' : 'error',
    summary: `${counts.passed} passed (${counts.flaky} flaky), ${counts.failed} failed, ${counts.skipped} skipped, ${counts.not_started} not started (${counts.total} test cases; ${counts.setup_failed} setup failures)`,
    spec_summary: JSON.stringify(lines.join('\n') || 'No test case results available').slice(1, -1),
  };
}

export function main() {
  let report;
  try {
    report = JSON.parse(fs.readFileSync('apps/client/pw-results.json', 'utf8'));
  } catch {
    /* Missing or invalid reports cannot establish a pass. */
  }
  const result = summarize(report, {
    execution: process.env.E2E_OUTCOME,
    skipped: process.env.E2E_PREVIEW_SKIPPED === 'true',
    cancelled: process.env.E2E_CANCELLED === 'true',
    job: process.env.E2E_JOB_STATUS,
  });
  fs.writeFileSync('e2e-outcome.json', JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(result)
        .map(([key, value]) => `${key}=${value}\n`)
        .join('')
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### E2E: ${result.label}\n\n${result.summary}\n`);
  }
  console.log(`${result.label}: ${result.summary}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

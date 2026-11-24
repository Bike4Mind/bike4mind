import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

export function stateFor(outcome) {
  return outcome === 'passed' ? 'success' : ['failed', 'incomplete'].includes(outcome) ? 'failure' : 'error';
}

export function summarize(report, { execution = 'skipped', skipped = false, cancelled = false, job = 'success' } = {}) {
  const counts = { passed: 0, flaky: 0, failed: 0, skipped: 0, not_started: 0, executed: 0, total: 0, setup_failed: 0 };
  const specs = [];
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
          ? test.expectedStatus === 'skipped'
            ? 'skipped'
            : 'not_started'
          : failed
            ? 'failed'
            : test.status === 'expected' || test.status === 'flaky'
              ? 'passed'
              : 'not_started';
        counts[bucket]++;
        local[bucket]++;
        if (bucket === 'passed' && test.status === 'flaky') {
          counts.flaky++;
          local.flaky++;
        }
        counts.total++;
        if (ran) counts.executed++;
      }
    }
    for (const child of suite.suites ?? []) walk(child, setup, local);
  }
  for (const suite of report?.suites ?? []) {
    const local = { passed: 0, flaky: 0, failed: 0, skipped: 0, not_started: 0 };
    walk(suite, false, local);
    if (Object.values(local).some(Boolean)) specs.push({ name: suite.title, ...local });
  }
  let outcome;
  if (cancelled || execution === 'cancelled') outcome = 'cancelled';
  else if (skipped) outcome = 'skipped';
  else if (counts.setup_failed || (report?.errors?.length && counts.executed === 0) || (!report && (execution !== 'skipped' || job === 'failure')))
    outcome = 'setup_failed';
  else if (counts.failed) outcome = 'failed';
  else if (execution === 'skipped') outcome = 'not_run';
  else if (counts.executed === 0) outcome = 'no_tests';
  else if (execution === 'failure' || report?.errors?.length) outcome = 'failed';
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
    state: stateFor(outcome),
    summary: `${counts.passed} passed (${counts.flaky} flaky), ${counts.failed} failed, ${counts.skipped} skipped, ${counts.not_started} not started (${counts.total} test cases; ${counts.setup_failed} setup failures)`,
    specs,
    // First line only (GITHUB_OUTPUT values are single-line); Playwright keeps ANSI colors in messages.
    error: stripVTControlCharacters(String(report?.errors?.[0]?.message ?? ''))
      .split('\n')[0]
      .slice(0, 300),
  };
}

const STATUS_EMOJI = {
  passed: ':white_check_mark:',
  skipped: ':fast_forward:',
  incomplete: ':warning:',
};

/**
 * Slack mrkdwn for the Status and Results fields (shortcodes render outside code blocks).
 * The line break is a literal backslash-n: GITHUB_OUTPUT values are single-line, and e2e-run.yml
 * splices these into a JSON payload, where it decodes to a newline.
 */
export function slackFields(result) {
  return {
    slack_status: `${STATUS_EMOJI[result.outcome] ?? ':x:'} ${result.label}`,
    slack_results:
      `:white_check_mark: ${result.passed} passed (${result.flaky} flaky)  :x: ${result.failed} failed  ` +
      `:fast_forward: ${result.skipped} skipped  :no_entry_sign: ${result.not_started} not started\\n` +
      `Total Cases: ${result.total}  Setup Failures: ${result.setup_failed}`,
  };
}

// Code blocks do not render :shortcodes:, so row markers are Unicode escapes (keeps the source ASCII).
const ROW_ICON = { failed: '\u{1F534}', incomplete: '\u{1F7E1}', passed: '\u{1F7E2}', skipped: '\u26AA' };
// Slack rejects a section text over 3000 characters; a full-suite table is longer, so it is split.
const SECTION_LIMIT = 2900;
const NUMBER_COLUMNS = [
  ['Pass', 'passed'],
  ['Flaky', 'flaky'],
  ['Fail', 'failed'],
  ['Skip', 'skipped'],
  ['Not started', 'not_started'],
];

function rowIcon(spec) {
  if (spec.failed) return ROW_ICON.failed;
  if (spec.not_started) return ROW_ICON.incomplete;
  return spec.passed ? ROW_ICON.passed : ROW_ICON.skipped;
}

/** One table row per spec file, rendered as Slack section blocks: a JSON fragment with a leading comma. */
export function slackSpecBlocks(specs, title, error = '') {
  if (!specs.length) {
    const detail = error ? `\n\`\`\`\n${error.replaceAll('`', "'")}\n\`\`\`` : '';
    const text = `*${title}*\nNo test case results available${detail}`;
    return `,${JSON.stringify({ type: 'section', text: { type: 'mrkdwn', text } })}`;
  }
  const names = specs.map(spec => spec.name.replace(/^e2e\//, '').replace(/\.spec\.[cm]?[jt]sx?$/, ''));
  const width = Math.max('Spec'.length, ...names.map(name => name.length));
  const cells = values => values.map(([label, value]) => String(value).padStart(label.length)).join('  ');
  // The header's leading spaces stand in for the row icon, which Slack draws about two characters wide.
  const header = `   ${'Spec'.padEnd(width)}  ${NUMBER_COLUMNS.map(([label]) => label).join('  ')}`;
  const rule = `   ${'-'.repeat(width)}  ${NUMBER_COLUMNS.map(([label]) => '-'.repeat(label.length)).join('  ')}`;
  const rows = specs.map(
    (spec, i) => `${rowIcon(spec)} ${names[i].padEnd(width)}  ${cells(NUMBER_COLUMNS.map(([label, key]) => [label, spec[key]]))}`
  );
  const chunks = [];
  let current = [];
  for (const row of rows) {
    const candidate = [...current, row];
    if (current.length && [header, rule, ...candidate].join('\n').length + title.length + 20 > SECTION_LIMIT) {
      chunks.push(current);
      current = [row];
    } else current = candidate;
  }
  chunks.push(current);
  return chunks
    .map((chunk, i) => {
      const heading = i === 0 ? `*${title}*\n` : '';
      // The newline after the fence keeps Slack from trimming the header's leading spaces.
      const text = `${heading}\`\`\`\n${[header, rule, ...chunk].join('\n')}\n\`\`\``;
      return `,${JSON.stringify({ type: 'section', text: { type: 'mrkdwn', text } })}`;
    })
    .join('');
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
  const { specs, ...outputs } = result;
  const suite = process.env.E2E_SUITE_NAME;
  Object.assign(outputs, slackFields(result), {
    slack_spec_blocks: slackSpecBlocks(specs, suite ? `${suite} Run Summary` : 'Test Run Summary', result.error),
  });
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
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

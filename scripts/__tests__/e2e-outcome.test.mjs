import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { slackFields, slackSpecBlocks, summarize } from '../e2e-outcome.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pwTest = (status, results, expectedStatus = status === 'skipped' ? 'skipped' : 'passed') => ({ status, results, expectedStatus });
const passed = () => pwTest('expected', [{ status: 'passed' }]);
const report = (...tests) => ({ suites: [{ title: 'example.spec.ts', specs: [{ tests }] }] });

test('counts project cases, skips and retries without counting skipped cases as passes', () => {
  const result = summarize(
    report(
      passed(),
      passed(),
      pwTest('skipped', [{ status: 'skipped' }]),
      pwTest('flaky', [{ status: 'failed' }, { status: 'passed' }]),
      pwTest('skipped', [], 'passed')
    ),
    { execution: 'success' }
  );
  assert.equal(result.passed, 3);
  assert.equal(result.flaky, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.not_started, 1);
  assert.equal(result.total, 5);
  assert.equal(result.executed, 3);
  assert.equal(result.outcome, 'incomplete');
});

test('distinguishes all execution outcomes and never infers pass from counts alone', () => {
  const cases = [
    [report(passed()), { execution: 'success' }, 'passed', 'success'],
    [report(passed()), { execution: 'failure' }, 'failed', 'failure'],
    [report(pwTest('unexpected', [{ status: 'failed' }])), { execution: 'success' }, 'failed', 'failure'],
    [report(), { execution: 'success' }, 'no_tests', 'error'],
    [report(), { execution: 'failure' }, 'no_tests', 'error'],
    [report(pwTest('skipped', [{ status: 'skipped' }])), { execution: 'success' }, 'no_tests', 'error'],
    [undefined, { skipped: true, execution: 'success' }, 'skipped', 'error'],
    [undefined, { cancelled: true }, 'cancelled', 'error'],
    [undefined, { execution: 'skipped', job: 'failure' }, 'setup_failed', 'error'],
    [undefined, { execution: 'failure' }, 'setup_failed', 'error'],
    [undefined, {}, 'not_run', 'error'],
    [
      { ...report(passed()), errors: [{ message: 'global teardown failed' }] },
      { execution: 'failure' },
      'failed',
      'failure',
    ],
  ];
  for (const [json, options, outcome, state] of cases) {
    assert.equal(summarize(json, options).outcome, outcome);
    assert.equal(summarize(json, options).state, state);
  }
});

test('setup failures are separate from test case counts', () => {
  const json = report(passed());
  json.suites.push({ title: 'auth.setup.ts', specs: [{ tests: [pwTest('unexpected', [{ status: 'failed' }])] }] });
  const result = summarize(json, { execution: 'failure' });
  assert.equal(result.setup_failed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.total, 1);
  assert.equal(result.outcome, 'setup_failed');
});

test('real Playwright did-not-run entries differ from intentional skips', () => {
  const result = summarize(report(
    passed(),
    pwTest('skipped', [], 'passed'),
    pwTest('skipped', [{ status: 'skipped' }], 'passed'),
    pwTest('skipped', [{ status: 'skipped' }], 'skipped')
  ), { execution: 'success' });
  assert.equal(result.not_started, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.outcome, 'incomplete');
});

test('global errors after execution are failures, not setup failures', () => {
  for (const tests of [[passed()], [pwTest('unexpected', [{ status: 'interrupted' }])]]) {
    const result = summarize({ ...report(...tests), errors: [{ message: 'Timed out waiting for the test suite to run' }] }, { execution: 'failure' });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.state, 'failure');
  }
  assert.equal(summarize({ ...report(), errors: [{ message: 'setup error' }] }, { execution: 'failure' }).outcome, 'setup_failed');
});

test('reports five skipped cases even when the spec is marked ok', () => {
  const json = report(passed(), ...Array.from({ length: 5 }, () => pwTest('skipped', [{ status: 'skipped' }])));
  json.suites[0].specs[0].ok = true;
  const result = summarize(json, { execution: 'success' });
  assert.equal(result.passed, 1);
  assert.equal(result.skipped, 5);
  assert.equal(result.total, 6);
  assert.deepEqual(result.specs, [{ name: 'example.spec.ts', passed: 1, flaky: 0, failed: 0, skipped: 5, not_started: 0 }]);
});

const blocksOf = fragment => JSON.parse(`[${fragment.slice(1)}]`);

test('Slack status and results carry pass/fail emoji', () => {
  const pass = slackFields(summarize(report(passed()), { execution: 'success' }));
  assert.equal(pass.slack_status, ':white_check_mark: Passed');
  const fail = slackFields(summarize(report(passed(), pwTest('unexpected', [{ status: 'failed' }])), { execution: 'failure' }));
  assert.equal(fail.slack_status, ':x: Failed');
  assert.equal(
    fail.slack_results,
    ':white_check_mark: 1 passed (0 flaky)  :x: 1 failed  :fast_forward: 0 skipped  :no_entry_sign: 0 not started\\nTotal Cases: 2  Setup Failures: 0'
  );
  assert.doesNotMatch(fail.slack_results, /\n/);
  assert.equal(
    JSON.parse(`"${fail.slack_results}"`).split('\n')[1],
    'Total Cases: 2  Setup Failures: 0'
  );
  const setup = summarize(report(passed()), { execution: 'failure' });
  setup.setup_failed = 2;
  assert.match(slackFields(setup).slack_results, /Total Cases: 1 {2}Setup Failures: 2$/);
  assert.equal(slackFields(summarize(report(passed(), pwTest('skipped', [], 'passed')), { execution: 'success' })).slack_status, ':warning: Incomplete');
  assert.equal(slackFields(summarize(undefined, { execution: 'failure' })).slack_status, ':x: Setup/deployment failed');
});

test('Slack spec table marks each spec and aligns its columns', () => {
  const json = { suites: [
    { title: 'e2e/admin.spec.ts', specs: [{ tests: [passed(), pwTest('unexpected', [{ status: 'failed' }])] }] },
    { title: 'notebook.spec.ts', specs: [{ tests: [...Array.from({ length: 11 }, passed), pwTest('flaky', [{ status: 'failed' }, { status: 'passed' }])] }] },
    { title: 'credits.spec.ts', specs: [{ tests: [pwTest('skipped', [{ status: 'skipped' }])] }] },
    { title: 'teams.spec.ts', specs: [{ tests: [passed(), pwTest('skipped', [], 'passed')] }] },
  ] };
  const [block] = blocksOf(slackSpecBlocks(summarize(json, { execution: 'failure' }).specs, 'Core Run Summary'));
  const lines = block.text.text.split('\n');
  assert.equal(lines[0], '*Core Run Summary*');
  assert.equal(lines[1], '```');
  assert.equal(lines.at(-1), '```');
  assert.match(lines[2], /^ {3}Spec +Pass {2}Flaky {2}Fail {2}Skip {2}Not started$/);
  const rows = lines.slice(4, -1);
  assert.deepEqual(rows.map(row => row.split(' ')[0]), ['\u{1F534}', '\u{1F7E2}', '\u26AA', '\u{1F7E1}']);
  assert.match(rows[0], /admin +1 +0 +1 +0 +0$/);
  assert.match(rows[1], /notebook +12 +1 +0 +0 +0$/);
  assert.equal(new Set(rows.map(row => row.length - row.split(' ')[0].length)).size, 1);
});

test('a long Slack spec table splits into sections under the Slack limit', () => {
  const suites = Array.from({ length: 80 }, (_, i) => ({ title: `feature-area-number-${i}.spec.ts`, specs: [{ tests: [passed()] }] }));
  const blocks = blocksOf(slackSpecBlocks(summarize({ suites }, { execution: 'success' }).specs, 'Test Run Summary'));
  assert.ok(blocks.length > 1);
  for (const block of blocks) {
    assert.ok(block.text.text.length <= 3000);
    assert.match(block.text.text, /```\n {3}Spec[\s\S]*\n```$/);
  }
  assert.equal(blocks.map(block => block.text.text.match(/feature-area-number-/g).length).reduce((a, b) => a + b), 80);
});

test('Slack summary shows the global error when no test ran', () => {
  const result = summarize({ suites: [], errors: [{ message: 'Error: Core data file not found\n  at stack' }] }, { execution: 'failure' });
  assert.equal(result.outcome, 'setup_failed');
  const [block] = blocksOf(slackSpecBlocks(result.specs, 'Test Run Summary', result.error));
  assert.equal(block.text.text, '*Test Run Summary*\nNo test case results available\n```\nError: Core data file not found\n```');
});

test('Slack error line drops terminal color codes', () => {
  const result = summarize({ suites: [], errors: [{ message: '\u001b[31mError: setup failed\u001b[39m\n  at x' }] }, { execution: 'failure' });
  assert.equal(result.error, 'Error: setup failed');
});

test('CLI emits real outputs for passing, failing, and no-run commands', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-outcome-'));
  try {
    fs.mkdirSync(path.join(cwd, 'apps/client'), { recursive: true });
    for (const [exit, json, expected] of [
      [0, report(passed()), 'passed'],
      [1, report(passed()), 'failed'],
      [0, report(), 'no_tests'],
      [1, report(), 'no_tests'],
    ]) {
      const execution = spawnSync(process.execPath, ['-e', `process.exit(${exit})`]);
      fs.writeFileSync(path.join(cwd, 'apps/client/pw-results.json'), JSON.stringify(json));
      const outputs = path.join(cwd, 'outputs');
      fs.writeFileSync(outputs, '');
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/e2e-outcome.mjs')], {
        cwd,
        env: {
          ...process.env,
          E2E_OUTCOME: execution.status === 0 ? 'success' : 'failure',
          GITHUB_OUTPUT: outputs,
          GITHUB_STEP_SUMMARY: path.join(cwd, 'summary'),
        },
      });
      assert.equal(result.status, 0, result.stderr.toString());
      assert.match(fs.readFileSync(outputs, 'utf8'), new RegExp(`^outcome=${expected}$`, 'm'));
      const written = fs.readFileSync(outputs, 'utf8');
      assert.doesNotMatch(written, /^specs=/m);
      assert.ok(blocksOf(written.match(/^slack_spec_blocks=(.*)$/m)[1]).length >= 1);
      const classified = JSON.parse(fs.readFileSync(path.join(cwd, 'e2e-outcome.json'), 'utf8'));
      const guard = spawnSync(process.execPath, [
        '-e',
        `process.exit(${['passed', 'skipped'].includes(classified.outcome) ? 0 : 1})`,
      ]);
      assert.equal(guard.status, expected === 'passed' ? 0 : 1);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('workflow and reusable callers preserve execution failure and always report', () => {
  const read = name => fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');
  for (const name of ['e2e-run.yml']) {
    const text = read(name);
    const execution = text.split('      - name: Run E2E tests')[1].split('      - name: ')[0];
    assert.doesNotMatch(execution, /continue-on-error/);
    assert.match(execution, /set -o pipefail/);
    assert.match(text, /id: results\n\s+if: always\(\)/);
    assert.match(
      text,
      /name: Enforce E2E outcome\n\s+if: \$\{\{ !cancelled\(\).*outcome != 'passed'.*outcome != 'skipped'/
    );
    assert.match(text, /if: always\(\).*steps.scrub.outcome == 'success'/);
    assert.doesNotMatch(text.split('    steps:')[0], /continue-on-error/);
  }
  for (const name of ['e2e-core.yml', 'e2e-manual.yml']) {
    assert.match(read(name), /uses: \.\/\.github\/workflows\/e2e-run.yml/);
    assert.doesNotMatch(read(name), /continue-on-error/);
  }
  assert.match(read('e2e-run.yml'), /value: \$\{\{ jobs.e2e-run.outputs.outcome \}\}/);
  assert.match(read('e2e-run.yml'), /outcome: \$\{\{ steps.results.outputs.outcome \}\}/);
  assert.match(read('e2e-on-label.yml'), /workflow_id: 'e2e-core.yml', ref: 'main'/);
});

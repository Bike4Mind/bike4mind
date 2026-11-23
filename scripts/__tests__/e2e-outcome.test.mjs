import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarize } from '../e2e-outcome.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pwTest = (status, results) => ({ status, results });
const passed = () => pwTest('expected', [{ status: 'passed' }]);
const report = (...tests) => ({ suites: [{ title: 'example.spec.ts', specs: [{ tests }] }] });

test('counts project cases, skips and retries without counting skipped cases as passes', () => {
  const result = summarize(
    report(
      passed(),
      passed(),
      pwTest('skipped', [{ status: 'skipped' }]),
      pwTest('flaky', [{ status: 'failed' }, { status: 'passed' }]),
      pwTest('expected', [])
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
      'setup_failed',
      'error',
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

test('reports five skipped cases even when the spec is marked ok', () => {
  const json = report(passed(), ...Array.from({ length: 5 }, () => pwTest('skipped', [{ status: 'skipped' }])));
  json.suites[0].specs[0].ok = true;
  const result = summarize(json, { execution: 'success' });
  assert.equal(result.passed, 1);
  assert.equal(result.skipped, 5);
  assert.equal(result.total, 6);
  assert.match(result.spec_summary, /1 passed, 0 failed, 5 skipped/);
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
  assert.match(read('e2e-on-label.yml'), /uses: \.\/\.github\/workflows\/e2e-core.yml/);
});

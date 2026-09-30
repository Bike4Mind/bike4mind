import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Guard on the QA suite name a manual E2E dispatch is ingested under (scripts/qa-report.mjs).
 *
 * The suite is part of the /status alarm's state key (apps/client/server/qa/streak.ts). A scoped
 * dispatch ("Auth" only) stored as the full suite shares that key with the scheduled run, so one
 * passing Auth run posts "recovered" for a failing full suite. So a scoped run must carry its own
 * suite name, and a full run must pass '' so e2e-run.yml's `inputs.suite_name || 'Full'` applies.
 *
 * The prep step's shell is executed rather than text-matched: the property is about what it
 * writes for each dropdown choice, and every choice is enumerated from the workflow itself so a
 * new option cannot slip through.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string) => fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', file), 'utf8');
const manual = read('e2e-manual.yml');

/** The `run: |` body of the step with `id: resolve`, dedented. */
function resolveScript(): string {
  const lines = manual.split(/\r?\n/);
  const idAt = lines.findIndex(l => /^\s*id: resolve\s*$/.test(l));
  const runAt = lines.findIndex((l, i) => i > idAt && /^\s*run: \|\s*$/.test(l));
  expect(idAt).toBeGreaterThan(-1);
  expect(runAt).toBeGreaterThan(idAt);
  const runIndent = lines[runAt].search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= runIndent) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter(l => l.trim()).map(l => l.search(/\S/)));
  return body.map(l => l.slice(indent)).join('\n');
}

/** The test_project dropdown options. */
function testProjectOptions(): string[] {
  const block = /^\s*test_project:\n[\s\S]*?^\s*options:\n((?:^\s*- .+\n)+)/m.exec(manual);
  expect(block).not.toBeNull();
  return (block?.[1] ?? '')
    .split('\n')
    .map(l => l.replace(/^\s*- /, '').trim())
    .filter(Boolean);
}

const script = resolveScript();

function resolve(env: Record<string, string>): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-manual-resolve-'));
  const out = path.join(dir, 'output');
  fs.writeFileSync(out, '');
  const res = spawnSync('bash', ['-c', script], {
    env: {
      PATH: process.env.PATH ?? '',
      GITHUB_OUTPUT: out,
      PR_NUMBER: '',
      STAGE_INPUT: 'dev',
      GATE_RUN: 'false',
      ...env,
    },
    encoding: 'utf8',
  });
  expect(res.status, res.stderr).toBe(0);
  const outputs = Object.fromEntries(
    fs
      .readFileSync(out, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  );
  fs.rmSync(dir, { recursive: true, force: true });
  return outputs;
}

describe('e2e-manual QA suite name', () => {
  const dispatch = (TEST_PROJECT: string, extra: Record<string, string> = {}) =>
    resolve({ EVENT_NAME: 'workflow_dispatch', TEST_PROJECT, ...extra });

  it('names every scoped dispatch after its test choice', () => {
    const scoped = testProjectOptions().filter(o => o !== 'All tests');
    expect(scoped.length).toBeGreaterThan(10);
    for (const choice of scoped) {
      const out = dispatch(choice);
      expect(out.suite_name, choice).toBe(choice);
      // The same runs are never promotable: the stamp and the suite name agree on "scoped".
      expect(out.stamp_promotable, choice).toBe('false');
    }
  });

  it('leaves a full run unnamed, so it is stored as Full', () => {
    expect(resolve({ EVENT_NAME: 'schedule', TEST_PROJECT: '' }).suite_name).toBe('');
    expect(dispatch('All tests').suite_name).toBe('');
    // A preview full run is not promotable, but it is still the full suite.
    expect(dispatch('All tests', { PR_NUMBER: '123' }).suite_name).toBe('');
    // An unknown choice falls back to the full suite, so it must not be named after the choice.
    expect(dispatch('Nope').suite_name).toBe('');
  });

  it('passes the resolved name through to e2e-run.yml, which defaults it to Full', () => {
    expect(manual).toMatch(/^\s*suite_name:\s+\$\{\{ steps\.resolve\.outputs\.suite_name \}\}$/m);
    expect(manual).toMatch(/^\s*suite_name:\s+\$\{\{ needs\.prep\.outputs\.suite_name \}\}$/m);
    expect(read('e2e-run.yml')).toMatch(/^\s*QA_SUITE: \$\{\{ inputs\.suite_name \|\| 'Full' \}\}$/m);
  });
});

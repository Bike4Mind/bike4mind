import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Behaviour tests for scripts/check-no-run-interpolation.py.
 *
 * The guard reads the relative path .github/workflows, so each case writes fixture workflows into
 * a throwaway dir and runs the real script with that dir as cwd. A missing python3 fails the test
 * rather than skipping it: the guard itself runs in CI and pre-commit, so it must be runnable there.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GUARD = path.join(REPO_ROOT, 'scripts', 'check-no-run-interpolation.py');

const sandboxes: string[] = [];

afterEach(() => {
  while (sandboxes.length) fs.rmSync(sandboxes.pop()!, { recursive: true, force: true });
});

function scan(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-interp-guard-'));
  sandboxes.push(dir);
  const workflows = path.join(dir, '.github', 'workflows');
  fs.mkdirSync(workflows, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(workflows, name), body);
  const r = spawnSync('python3', [GUARD], { cwd: dir, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { status: r.status, out: r.stdout + r.stderr };
}

const workflow = (steps: string) => `name: t
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${steps}`;

describe('check-no-run-interpolation.py', () => {
  it('passes a workflow that hands the value through env:', () => {
    const r = scan({
      'ok.yml': workflow(`      - name: Echo
        if: \${{ github.event_name == 'push' }}
        env:
          TITLE: \${{ github.event.pull_request.title }}
        with:
          ref: \${{ github.sha }}
        run: echo "$TITLE"
`),
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain('OK:');
  });

  it('flags an inline run: and reports file, run: line and expression', () => {
    const r = scan({
      'bad.yml': workflow(`      - name: Echo
        run: echo \${{ github.event.pull_request.title }}
`),
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain('.github/workflows/bad.yml:8  ->  ${{ github.event.pull_request.title }}');
  });

  it.each(['|', '>-'])('flags a "run: %s" block scalar and reports the run: line', marker => {
    const r = scan({
      'block.yml': workflow(`      - name: Echo
        run: ${marker}
          set -e
          echo \${{ inputs.name }}
`),
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain('.github/workflows/block.yml:8  ->  ${{ inputs.name }}');
  });

  it('flags a wrapped inline scalar on its continuation line', () => {
    const r = scan({
      'wrapped.yml': workflow(`      - name: Echo
        run: echo hello
          \${{ inputs.name }}
`),
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain('.github/workflows/wrapped.yml:8  ->  ${{ inputs.name }}');
  });

  it('ignores a job named run, which is not a script', () => {
    // After another job's steps:, so it is the run: key sitting no deeper than steps: that keeps it out.
    const r = scan({
      'job.yml': `name: t
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
  run:
    runs-on: \${{ inputs.runner }}
    if: \${{ github.event_name == 'push' }}
    steps:
      - run: echo ok
`,
    });
    expect(r.status).toBe(0);
  });

  it('ignores a job-level defaults run: that follows the steps', () => {
    // Indented deeper than steps:, so only the guard noticing that steps: has ended keeps this out.
    const r = scan({
      'defaults.yml': workflow(`      - run: echo ok
    defaults:
      run:
        working-directory: \${{ inputs.dir }}
`),
    });
    expect(r.status).toBe(0);
  });

  it('scans .yaml files too', () => {
    const r = scan({ 'bad.yaml': workflow(`      - run: echo \${{ github.ref }}\n`) });
    expect(r.status).toBe(1);
    expect(r.out).toContain('.github/workflows/bad.yaml:7  ->  ${{ github.ref }}');
  });
});

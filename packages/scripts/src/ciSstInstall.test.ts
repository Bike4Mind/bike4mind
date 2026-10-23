import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJobs, readSteps } from './ciWorkflowText';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INSTALL_SCRIPT = path.join(REPO_ROOT, 'scripts/ci-sst-install.sh');
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runInstall(failures: number) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ci-sst-install-'));
  temporaryDirectories.push(directory);
  const counterPath = path.join(directory, 'count');
  const argumentsPath = path.join(directory, 'arguments');
  const delaysPath = path.join(directory, 'delays');
  writeFileSync(counterPath, '0');
  writeFileSync(delaysPath, '');
  writeFileSync(
    path.join(directory, 'pnpm'),
    `#!/bin/sh
count=$(cat "$SST_INSTALL_TEST_COUNTER")
count=$((count + 1))
printf '%s' "$count" > "$SST_INSTALL_TEST_COUNTER"
printf '%s\\n' "$*" >> "$SST_INSTALL_TEST_ARGUMENTS"
if [ "$count" -le "$SST_INSTALL_TEST_FAILURES" ]; then exit 37; fi
exit 0
`,
    { mode: 0o700 }
  );
  writeFileSync(
    path.join(directory, 'sleep'),
    `#!/bin/sh
printf '%s\\n' "$1" >> "$SST_INSTALL_TEST_DELAYS"
`,
    { mode: 0o700 }
  );

  const result = spawnSync('bash', [INSTALL_SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${directory}${path.delimiter}${process.env.PATH ?? ''}`,
      CI: 'true',
      SST_INSTALL_TEST_COUNTER: counterPath,
      SST_INSTALL_TEST_ARGUMENTS: argumentsPath,
      SST_INSTALL_TEST_DELAYS: delaysPath,
      SST_INSTALL_TEST_FAILURES: String(failures),
    },
  });
  if (result.error) throw result.error;
  return {
    ...result,
    attempts: Number(readFileSync(counterPath, 'utf8')),
    arguments: readFileSync(argumentsPath, 'utf8').trim().split('\n'),
    delays: readFileSync(delaysPath, 'utf8').trim().split('\n').filter(Boolean),
  };
}

describe('CI SST installation', () => {
  it('returns immediately on success and enables diagnostics', () => {
    const result = runInstall(0);
    expect(result.status).toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.arguments).toEqual(['sst install --print-logs']);
    expect(result.delays).toEqual([]);
  });

  it.each([1, 2])('recovers after %i transient installation failures', failures => {
    const result = runInstall(failures);
    expect(result.status).toBe(0);
    expect(result.attempts).toBe(failures + 1);
    expect(result.arguments).toEqual(Array.from({ length: failures + 1 }, () => 'sst install --print-logs'));
    expect(result.delays).toEqual(failures === 1 ? ['5'] : ['5', '10']);
    expect(result.stderr).toContain('::warning::SST installation failed (exit 37)');
    expect(result.stderr).not.toContain('::error::');
  });

  it('preserves failure after the retry limit without a final sleep', () => {
    const result = runInstall(3);
    expect(result.status).toBe(37);
    expect(result.attempts).toBe(3);
    expect(result.arguments).toEqual(Array.from({ length: 3 }, () => 'sst install --print-logs'));
    expect(result.delays).toEqual(['5', '10']);
    expect(result.stderr).toContain('::error::SST installation failed after 3 attempts (exit 37).');
  });

  it('wires every SST type-generation job through the helper without weakening its gate', () => {
    const workflow = readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    const installJobs = readJobs(workflow).flatMap(job =>
      readSteps(job.body)
        .filter(step => step.includes('- name: Generate SST types'))
        .map(step => ({ name: job.name, step }))
    );
    expect(installJobs.map(job => job.name).sort()).toEqual(['cli-e2e', 'lint', 'test-shards', 'typecheck']);
    for (const { step } of installJobs) {
      expect(step).toContain('run: bash scripts/ci-sst-install.sh');
      expect(step).toContain("CI: 'true'");
      expect(step).not.toContain('continue-on-error');
    }
    expect(workflow).not.toContain('run: pnpm sst install');
  });
});

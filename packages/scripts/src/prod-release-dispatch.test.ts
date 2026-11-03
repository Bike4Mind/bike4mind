import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guard: the production-release dispatch keeps accepting the inputs the deployer actually sends.
 *
 * `prod-release.yml` runs only on dispatch, so a dropped input first shows up as a failed release
 * run that creates no tag - and the deployer treats that dispatch as best-effort, so the deploy
 * itself stays green. The resolve step's inline bash is executed here with the shapes that reach
 * it in practice, rather than text-matched.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const yaml = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'prod-release.yml'), 'utf8');
const STEP = '- name: Resolve deployed commit SHA\n';

function stepBlock(): string {
  const start = yaml.indexOf(STEP);
  if (start === -1) throw new Error(`step not found in prod-release.yml: ${STEP.trim()}`);
  const next = yaml.indexOf('\n      - name: ', start + 1);
  return yaml.slice(start, next === -1 ? undefined : next);
}

/** The step's `run: |` body, dedented. */
function runScript(): string {
  const block = stepBlock();
  const marker = block.indexOf('\n        run: |\n');
  if (marker === -1) throw new Error('run block not found in the resolve-sha step');
  const lines = block.slice(marker + '\n        run: |\n'.length).split('\n');
  const body: string[] = [];
  for (const line of lines) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

const SHA = 'd392c813604dba395435bebb924a45ec6745ee71';

/** Run the step's script the way the workflow does, returning its exit code and emitted output. */
function resolveDispatch(inputs: { deployedSha?: string; targetBranch?: string; dryRun: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-release-'));
  const outputFile = path.join(dir, 'output');
  fs.writeFileSync(outputFile, '');
  try {
    execFileSync('bash', ['-c', runScript()], {
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputFile,
        DEPLOYED_SHA_INPUT: inputs.deployedSha ?? '',
        TARGET_BRANCH_INPUT: inputs.targetBranch ?? '',
        DRY_RUN: inputs.dryRun,
      },
      stdio: 'pipe',
    });
    return { ok: true as const, output: fs.readFileSync(outputFile, 'utf8') };
  } catch (error) {
    return { ok: false as const, output: fs.readFileSync(outputFile, 'utf8'), error };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('prod-release.yml resolve-sha step', () => {
  it('declares the deprecated target_branch alias with a HEAD default', () => {
    const input = /^ {6}target_branch:\n((?: {8}.*\n)+)/m.exec(yaml);
    expect(input?.[1]).toContain("default: 'HEAD'");
  });

  it('passes both dispatch inputs to the resolve step', () => {
    const block = stepBlock();
    expect(block).toContain('DEPLOYED_SHA_INPUT: ${{ github.event.inputs.deployed_sha }}');
    expect(block).toContain('TARGET_BRANCH_INPUT: ${{ github.event.inputs.target_branch }}');
  });

  const RESOLVES_SHA: Array<[string, { deployedSha?: string; targetBranch?: string; dryRun: string }]> = [
    ['the deployer sends target_branch only', { targetBranch: SHA, dryRun: 'false' }],
    ['a caller sends deployed_sha', { deployedSha: SHA, dryRun: 'false' }],
    [
      'both are sent, deployed_sha wins',
      { deployedSha: SHA, targetBranch: 'ffffffffffffffffffffffffffffffffffffffff', dryRun: 'false' },
    ],
  ];

  it.each(RESOLVES_SHA)('resolves the deployed SHA when %s', (_label, inputs) => {
    const result = resolveDispatch(inputs);
    expect(result.ok).toBe(true);
    expect(result.output).toContain(`deployed_sha=${SHA}`);
  });

  it('resolves HEAD for a manual dispatch, which arrives with the input default', () => {
    const result = resolveDispatch({ dryRun: 'true', targetBranch: 'HEAD' });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('deployed_sha=HEAD');
  });

  it('still refuses a real run with no SHA', () => {
    expect(resolveDispatch({ dryRun: 'false' }).ok).toBe(false);
  });
});

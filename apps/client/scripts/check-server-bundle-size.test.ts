// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error - plain .mjs build script, intentionally not part of the TS program
import {
  evaluateBudget,
  failsBudget,
  parseReserveMib,
  topContributors,
  worstStatus,
  LAMBDA_UNZIPPED_LIMIT_BYTES,
} from './check-server-bundle-size.mjs';

const LIMIT = LAMBDA_UNZIPPED_LIMIT_BYTES;
const BUDGET = Math.floor(LIMIT * 0.9);
const WARN = Math.floor(LIMIT * 0.85);
const MIB = 1048576;

describe('evaluateBudget', () => {
  it('holds the documented Lambda limit, so a silent edit cannot loosen the gate', () => {
    // 250 MiB. Hard-coded rather than derived: AWS does not expose it and it is not adjustable.
    expect(LIMIT).toBe(262144000);
  });

  it.each([
    ['well under budget', 100_000_000, 'ok'],
    ['exactly at the warn line', WARN, 'ok'],
    ['one byte over the warn line', WARN + 1, 'near-budget'],
    ['exactly at budget', BUDGET, 'near-budget'],
    ['one byte over budget', BUDGET + 1, 'over-budget'],
    ['exactly at the AWS limit', LIMIT, 'over-budget'],
    ['over the AWS limit', LIMIT + 1, 'over-limit'],
  ])('classifies %s (%d bytes) as %s', (_label, measuredBytes, expected) => {
    expect(evaluateBudget({ measuredBytes }).status).toBe(expected);
  });

  it('reports the real pre-fix bundle as over budget while still deployable', () => {
    // The measured size of the deployed bundle that preceded the googleapis narrowing. AWS
    // accepted it, yet it was only 17.9 MB from rejection - precisely the state this budget
    // exists to surface rather than discover through a failed deploy.
    const result = evaluateBudget({ measuredBytes: 243_393_532 });
    expect(result.status).toBe('over-budget');
    expect(result.percentOfLimit).toBeCloseTo(92.8, 1);
  });

  it('computes headroom against the limit, not the budget', () => {
    expect(evaluateBudget({ measuredBytes: LIMIT - 1_048_576 }).headroomBytes).toBe(1_048_576);
  });

  it('judges measured bytes plus the reserve, and reports both', () => {
    // An open-core build that looks comfortable on its own but not once the reserve is added.
    const result = evaluateBudget({ measuredBytes: 150_000_000, reserveBytes: 90_000_000 });
    expect(result.status).toBe('over-budget');
    expect(result.measuredBytes).toBe(150_000_000);
    expect(result.reserveBytes).toBe(90_000_000);
    expect(result.judgedBytes).toBe(240_000_000);
    expect(result.headroomBytes).toBe(LIMIT - 240_000_000);
  });

  it('carries the reserve into the warn and over-limit tiers too', () => {
    expect(evaluateBudget({ measuredBytes: 1, reserveBytes: 224 * MIB }).status).toBe('near-budget');
    expect(evaluateBudget({ measuredBytes: 1, reserveBytes: 251 * MIB }).status).toBe('over-limit');
  });

  it('honours an explicit budget fraction', () => {
    expect(evaluateBudget({ measuredBytes: 200_000_000, budgetFraction: 0.5 }).status).toBe('over-budget');
    expect(evaluateBudget({ measuredBytes: 200_000_000, budgetFraction: 0.99 }).status).toBe('ok');
  });

  it('honours an explicit warn fraction', () => {
    expect(evaluateBudget({ measuredBytes: 200_000_000, warnFraction: 0.5 }).status).toBe('near-budget');
    expect(evaluateBudget({ measuredBytes: 200_000_000, warnFraction: 0.9 }).status).toBe('ok');
  });
});

describe('worstStatus', () => {
  it.each([
    [['ok', 'ok'], 'ok'],
    [['ok', 'near-budget'], 'near-budget'],
    [['near-budget', 'over-budget'], 'over-budget'],
    [['ok', 'over-budget'], 'over-budget'],
    [['over-budget', 'over-limit', 'ok'], 'over-limit'],
    [[], 'ok'],
  ])('reduces %j to %s', (statuses, expected) => {
    expect(worstStatus(statuses)).toBe(expected);
  });
});

describe('failsBudget', () => {
  it.each([
    ['ok', false],
    ['near-budget', false],
    ['over-budget', true],
    ['over-limit', true],
  ])('%s fails the gate: %s', (status, expected) => {
    expect(failsBudget(status)).toBe(expected);
  });
});

describe('parseReserveMib', () => {
  it('treats an absent flag and an unset CI variable as no reserve', () => {
    expect(parseReserveMib(undefined)).toBe(0);
    expect(parseReserveMib('')).toBe(0);
    expect(parseReserveMib('  ')).toBe(0);
  });

  it('converts MiB to bytes', () => {
    expect(parseReserveMib('0')).toBe(0);
    expect(parseReserveMib('64')).toBe(64 * MIB);
    expect(parseReserveMib(' 64 ')).toBe(64 * MIB);
    expect(parseReserveMib('0.5')).toBe(524288);
  });

  // A plain decimal is the only accepted spelling: Number() would read "0x10" as 16 and "1e3" as
  // 1000, so a typo in the repository variable would silently become a different allowance.
  it.each(['-1', 'abc', '12MiB', 'Infinity', '0x10', '0b11', '1e3', '+1'])(
    'rejects %j rather than reading it as some other number',
    value => {
      expect(() => parseReserveMib(value)).toThrow(/--reserve-mib/);
    }
  );
});

describe('topContributors', () => {
  it('groups by the first three path segments so the culprit is named, not just node_modules', () => {
    const files: Array<[string, number]> = [
      ['node_modules/.pnpm/googleapis@173.0.0/build/one.js', 30],
      ['node_modules/.pnpm/googleapis@173.0.0/build/two.js', 5],
      ['node_modules/.pnpm/tiktoken@1.0.22/index.js', 20],
      ['apps/client/.next/server/page.js', 10],
    ];

    expect(topContributors(files)).toEqual([
      ['node_modules/.pnpm/googleapis@173.0.0', 35],
      ['node_modules/.pnpm/tiktoken@1.0.22', 20],
      ['apps/client/.next', 10],
    ]);
  });

  it('limits the list to the requested count', () => {
    const files: Array<[string, number]> = Array.from({ length: 30 }, (_unused, i) => [`a/b/pkg${i}/f.js`, i]);
    expect(topContributors(files, 3)).toHaveLength(3);
  });

  it('handles a shallow path without inventing segments', () => {
    expect(topContributors([['index.mjs', 7]])).toEqual([['index.mjs', 7]]);
  });
});

// The helpers above are only half the contract: what CI depends on is main()'s exit codes and the
// annotations it prints, so those run the real script in a child process.
describe('--enforce CLI contract', () => {
  const SCRIPT = fileURLToPath(new URL('./check-server-bundle-size.mjs', import.meta.url));

  // One byte, so the reserve alone decides which tier the result lands in.
  const bundleDir = mkdtempSync(join(tmpdir(), 'bundle-size-bundle-'));
  const scratchDir = mkdtempSync(join(tmpdir(), 'bundle-size-scratch-'));
  writeFileSync(join(bundleDir, 'payload.bin'), 'x');

  afterAll(() => {
    rmSync(bundleDir, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  });

  // The child gets an explicit environment rather than this process's: it must never append to the
  // real run's step summary.
  const runCli = (args: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { GITHUB_STEP_SUMMARY: '', ...extraEnv },
    });

  it('warns and exits 0 for a near-budget bundle', () => {
    const run = runCli(['--enforce', `--dir=${bundleDir}`, '--reserve-mib=224']);
    // Proof main() ran at all, which is what makes a silent skip detectable.
    expect(run.stdout).toContain('unzipped across');
    expect(run.stdout).toContain('::warning::');
    expect(run.stdout).not.toContain('::error::');
    expect(run.status).toBe(0);
  });

  it('fails on an over-budget bundle', () => {
    const run = runCli(['--enforce', `--dir=${bundleDir}`, '--reserve-mib=225']);
    expect(run.stdout).toContain('::error::');
    expect(run.status).toBe(1);
  });

  it('fails on a bundle past the unzipped limit', () => {
    const run = runCli(['--enforce', `--dir=${bundleDir}`, '--reserve-mib=251']);
    expect(run.stdout).toContain('::error::');
    expect(run.status).toBe(1);
  });

  it('exits 2 on a malformed reserve rather than applying none', () => {
    const run = runCli(['--enforce', `--dir=${bundleDir}`, '--reserve-mib=abc']);
    expect(run.stderr).toContain('::error::--reserve-mib');
    expect(run.status).toBe(2);
  });

  it('exits 2 when --reserve-mib is passed without a value', () => {
    const run = runCli(['--enforce', `--dir=${bundleDir}`, '--reserve-mib']);
    expect(run.stderr).toContain('::error::--reserve-mib needs a value');
    expect(run.status).toBe(2);
  });

  it('warns but still passes when the reserve is passed from an unset variable', () => {
    const run = runCli(['--enforce', `--dir=${bundleDir}`, '--reserve-mib=']);
    expect(run.stdout).toContain('is empty');
    expect(run.status).toBe(0);
  });

  it('does not report an empty reserve when the flag is absent', () => {
    const run = runCli(['--enforce', `--dir=${bundleDir}`]);
    expect(run.stdout).not.toContain('is empty');
    expect(run.status).toBe(0);
  });

  it('does not report an empty reserve for an explicit zero', () => {
    const run = runCli(['--enforce', `--dir=${bundleDir}`, '--reserve-mib=0']);
    expect(run.stdout).not.toContain('is empty');
    expect(run.status).toBe(0);
  });

  it('measures the bundle when invoked through a symlink', () => {
    // Node resolves import.meta.url to the real path while argv[1] keeps the link, so a bare
    // comparison would skip main() and exit 0 - an over-budget bundle passing silently.
    const link = join(scratchDir, 'check-server-bundle-size-link.mjs');
    symlinkSync(SCRIPT, link);
    const run = spawnSync(process.execPath, [link, '--enforce', `--dir=${bundleDir}`, '--reserve-mib=251'], {
      encoding: 'utf8',
      env: { GITHUB_STEP_SUMMARY: '' },
    });
    expect(run.stdout).toContain('unzipped across');
    expect(run.status).toBe(1);
  });

  it('counts a symlinked file at its target size and skips symlinked or dangling links', () => {
    // A symlinked file is counted at its target's size, while a symlinked directory and a dangling
    // link contribute nothing. Undercounting here would pass a bundle the deploy then rejects.
    const targetDir = mkdtempSync(join(tmpdir(), 'bundle-size-target-'));
    const linkedBundle = mkdtempSync(join(tmpdir(), 'bundle-size-links-'));
    try {
      writeFileSync(join(targetDir, 'target.bin'), Buffer.alloc(MIB));
      mkdirSync(join(targetDir, 'nested'));
      writeFileSync(join(targetDir, 'nested', 'inside.bin'), Buffer.alloc(MIB));

      symlinkSync(join(targetDir, 'target.bin'), join(linkedBundle, 'linked-file.bin'));
      symlinkSync(join(targetDir, 'nested'), join(linkedBundle, 'linked-dir'), 'dir');
      symlinkSync(join(linkedBundle, 'missing.bin'), join(linkedBundle, 'dangling.bin'));

      const run = runCli(['--enforce', `--dir=${linkedBundle}`]);
      expect(run.stdout).toContain('1.0 MB unzipped across 1 files');
      expect(run.status).toBe(0);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
      rmSync(linkedBundle, { recursive: true, force: true });
    }
  });

  it('does not throw when the module is imported by a process whose argv[1] is not a path', () => {
    // Node's -e mode leaves argv[1] as the first positional argument, so this reproduces an importer
    // whose argv[1] is not a real file: the direct-invocation check must read that as "not invoked
    // directly" rather than throw out of the import.
    const run = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(SCRIPT)}); console.log('imported ok');`,
        join(scratchDir, 'not-a-real-path.mjs'),
      ],
      { encoding: 'utf8' }
    );
    expect(run.stderr).not.toContain('ENOENT');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('imported ok');
  });

  it('writes the reserve and the judged total to the step summary', () => {
    const summaryPath = join(scratchDir, 'summary.md');
    const run = runCli(['--enforce', `--dir=${bundleDir}`, '--reserve-mib=64'], { GITHUB_STEP_SUMMARY: summaryPath });
    expect(run.status).toBe(0);
    const summary = readFileSync(summaryPath, 'utf8');
    expect(summary).toContain('| unzipped | reserve | judged |');
    expect(summary).toMatch(/\| 64\.0 MB \| 64\.0 MB \|/);
    expect(summary).toContain('| ok |');
  });
});

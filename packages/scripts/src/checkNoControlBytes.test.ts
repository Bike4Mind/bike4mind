import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Behaviour tests for scripts/check-no-control-bytes.sh (the guard added for #1385).
 *
 * Each case builds a throwaway git repo under the OS temp dir and runs the real script
 * against it, so the assertions cover the shipped shell rather than a reimplementation.
 * Nothing here touches the working repo.
 *
 * Must stay in sync with the guard's three modes: default/--staged, --changed <base>, --all.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GUARD = path.join(REPO_ROOT, 'scripts', 'check-no-control-bytes.sh');

// Absolute, because the fail-closed case stubs PATH down to git only -- a bare 'bash'
// would then fail to spawn at all, which is a different failure than the one under test.
const BASH = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim() || '/bin/bash';

const sandboxes: string[] = [];

afterEach(() => {
  while (sandboxes.length) fs.rmSync(sandboxes.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A fresh git repo with one empty commit; returns its path and that commit's sha. */
function makeRepo(): { dir: string; base: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-guard-'));
  sandboxes.push(dir);
  git(dir, 'init', '-q', '.');
  git(dir, 'config', 'user.email', 'test@example.test');
  git(dir, 'config', 'user.name', 'test');
  // A fixture deliberately contains CR; keep git from warning or rewriting it.
  git(dir, 'config', 'core.safecrlf', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

/** Write raw bytes (control chars survive; a normal string would be re-encoded fine too). */
function write(dir: string, name: string, contents: string) {
  fs.writeFileSync(path.join(dir, name), Buffer.from(contents, 'binary'));
}

/** A PATH containing only git, so the guard can list files but not scan them. */
function makeStubBin(): string {
  const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-guard-bin-'));
  sandboxes.push(stubBin);
  const gitPath = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  fs.symlinkSync(gitPath, path.join(stubBin, 'git'));
  return stubBin;
}

function runGuard(dir: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(BASH, [GUARD, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (r.error) throw r.error; // a spawn failure is not a guard verdict; surface it as such
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('check-no-control-bytes.sh', () => {
  it('is present and executable', () => {
    expect(fs.existsSync(GUARD)).toBe(true);
    // Mode matters: the hook and CI both invoke it, and a non-executable guard is a silent no-op risk.
    expect(fs.statSync(GUARD).mode & 0o111).toBeGreaterThan(0);
  });

  describe('staged mode (the pre-commit hook path)', () => {
    it('allows tab, LF and CR, which are not violations', () => {
      const { dir } = makeRepo();
      write(dir, 'clean.ts', 'export const ok = 1;\n\tconst tabbed = 2;\r\n');
      git(dir, 'add', 'clean.ts');
      expect(runGuard(dir).status).toBe(0);
    });

    it('rejects a raw NUL and names the offending file', () => {
      const { dir } = makeRepo();
      write(dir, 'nul.ts', 'export const bad = 1;\x00\n');
      git(dir, 'add', 'nul.ts');
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('nul.ts');
    });

    it('rejects DEL (0x7f)', () => {
      const { dir } = makeRepo();
      write(dir, 'del.ts', 'export const bad = 1;\x7f\n');
      git(dir, 'add', 'del.ts');
      expect(runGuard(dir).status).toBe(1);
    });

    it('rejects 0x03 / 0x04 in a .tsx file', () => {
      const { dir } = makeRepo();
      write(dir, 'ctrl.tsx', 'const a = "\x03";\nconst b = "\x04";\n');
      git(dir, 'add', 'ctrl.tsx');
      expect(runGuard(dir).status).toBe(1);
    });

    it('ignores a NUL outside .ts/.tsx, since that is the declared scope', () => {
      const { dir } = makeRepo();
      write(dir, 'notes.md', 'doc with a NUL: \x00\n');
      git(dir, 'add', 'notes.md');
      expect(runGuard(dir).status).toBe(0);
    });

    it('passes when nothing is staged', () => {
      const { dir } = makeRepo();
      expect(runGuard(dir).status).toBe(0);
    });
  });

  describe('--changed mode (the CI path)', () => {
    it('rejects a NUL introduced in a commit after the base', () => {
      const { dir, base } = makeRepo();
      write(dir, 'added.ts', 'export const later = 1;\x00\n');
      git(dir, 'add', 'added.ts');
      git(dir, 'commit', '-q', '-m', 'add a file containing a NUL');
      expect(runGuard(dir, ['--changed', base]).status).toBe(1);
    });

    it('passes when the commits after the base are clean', () => {
      const { dir, base } = makeRepo();
      write(dir, 'fine.ts', 'export const fine = 1;\n');
      git(dir, 'add', 'fine.ts');
      git(dir, 'commit', '-q', '-m', 'add a clean file');
      expect(runGuard(dir, ['--changed', base]).status).toBe(0);
    });

    // The important one: both "scanned everything" and "scanned nothing" exit 0 on a clean
    // tree, so an unresolvable base must visibly widen the scan instead of quietly passing.
    it.each([
      ['an empty base', ''],
      ['an all-zero base, as a new-branch push sends', '0'.repeat(40)],
      ['a nonexistent sha', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
    ])('falls back to a full scan given %s', (_label, base) => {
      const { dir } = makeRepo();
      write(dir, 'added.ts', 'export const later = 1;\x00\n');
      git(dir, 'add', 'added.ts');
      git(dir, 'commit', '-q', '-m', 'add a file containing a NUL');
      const r = runGuard(dir, ['--changed', base]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('unresolvable');
    });
  });

  describe('--all mode', () => {
    it('rejects a tracked file containing a NUL', () => {
      const { dir } = makeRepo();
      write(dir, 'added.ts', 'export const later = 1;\x00\n');
      git(dir, 'add', 'added.ts');
      git(dir, 'commit', '-q', '-m', 'add a file containing a NUL');
      expect(runGuard(dir, ['--all']).status).toBe(1);
    });

    it('skips a path git tracks but the worktree no longer has', () => {
      const { dir } = makeRepo();
      write(dir, 'gone.ts', 'export const gone = 1;\n');
      git(dir, 'add', 'gone.ts');
      git(dir, 'commit', '-q', '-m', 'add a file');
      fs.rmSync(path.join(dir, 'gone.ts'));
      const r = runGuard(dir, ['--all']);
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain("Can't open");
    });

    // Skipping the missing path must not abort the scan: a sibling in the same invocation
    // still has to be checked, or one deleted file would mask every later violation.
    it('keeps scanning siblings after skipping a missing path', () => {
      const { dir } = makeRepo();
      write(dir, 'gone.ts', 'export const gone = 1;\n');
      write(dir, 'zz-bad.ts', 'export const bad = 1;\x00\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'add two files');
      fs.rmSync(path.join(dir, 'gone.ts'));
      const r = runGuard(dir, ['--all']);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('zz-bad.ts');
    });
  });

  it('fails closed when perl is unavailable rather than reporting clean', () => {
    const { dir } = makeRepo();
    write(dir, 'nul.ts', 'export const bad = 1;\x00\n');
    git(dir, 'add', 'nul.ts');

    const stubBin = makeStubBin();
    const r = runGuard(dir, ['--all'], { PATH: stubBin });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('perl not found');
  });

  // Distinct from "perl not found": perl exists, so the command -v check passes, but the
  // scan itself dies. That must not read as a clean tree either.
  it('fails closed when perl exists but exits non-zero', () => {
    const { dir } = makeRepo();
    write(dir, 'nul.ts', 'export const bad = 1;\x00\n');
    git(dir, 'add', 'nul.ts');

    const stubBin = makeStubBin();
    const stub = path.join(stubBin, 'perl');
    fs.writeFileSync(stub, '#!/bin/sh\nexit 3\n');
    fs.chmodSync(stub, 0o755);

    const r = runGuard(dir, ['--all'], { PATH: stubBin });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('failing closed');
  });

  it('fails closed when the file listing fails, rather than passing an empty list', () => {
    // Outside any git repo, so `git ls-files` errors. A process substitution would hide that
    // and yield a bogus clean pass; the pipeline must surface it.
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-guard-norepo-'));
    sandboxes.push(notARepo);
    const r = runGuard(notARepo, ['--all']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('failing closed');
  });

  it('rejects an unknown option instead of silently scanning staged files', () => {
    const { dir } = makeRepo();
    const r = runGuard(dir, ['--chagned']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown option '--chagned'");
    expect(r.stderr).toContain('usage:');
  });

  describe('security: filenames must never reach perl @ARGV', () => {
    // perl -n wraps the body in `while (<>)`, and the diamond operator does a magic
    // 2-argument open on @ARGV entries, so a file merely NAMED `|cmd.ts` would run `cmd`.
    // That is code execution from the same careless-contributor case this guard exists for.
    const hostile = '|touch PWNED;.ts';

    it('does not execute a command embedded in a filename', () => {
      const { dir } = makeRepo();
      write(dir, hostile, 'export const x = 1;\n');
      git(dir, 'add', '-A');
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.join(dir, 'PWNED'))).toBe(false);
    });

    it('still scans a file whose name begins with a pipe', () => {
      const { dir } = makeRepo();
      write(dir, hostile, 'export const x = 1;\x00\n');
      git(dir, 'add', '-A');
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(hostile);
      expect(fs.existsSync(path.join(dir, 'PWNED'))).toBe(false);
    });

    it('does not treat a file named "-" as stdin', () => {
      const { dir } = makeRepo();
      write(dir, '-.ts', 'export const x = 1;\x00\n');
      git(dir, 'add', '-A');
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('-.ts');
    });
  });

  it('scans a non-ASCII path that git would otherwise C-quote', () => {
    // With core.quotePath on (git's default), a non-ASCII path is emitted as
    // "caf\303\251.ts" -- quotes included -- which names no real file. The -z listing
    // avoids the quoting entirely.
    const { dir } = makeRepo();
    git(dir, 'config', 'core.quotePath', 'true');
    write(dir, 'café.ts', 'export const bad = 1;\x00\n');
    git(dir, 'add', '-A');
    const r = runGuard(dir);
    expect(r.status).toBe(1);
  });

  describe('renames', () => {
    // Git detects renames by default and emits them as a single R<score> record. R is not in
    // ACM, so an ACM filter drops the record entirely and a rename-plus-edit commits clean.
    // Enough lines that git scores the change as a rename rather than delete-plus-add.
    const body = Array.from({ length: 5 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';

    function repoWithCommittedFile() {
      const { dir } = makeRepo();
      write(dir, 'a.ts', body);
      git(dir, 'add', 'a.ts');
      git(dir, 'commit', '-q', '-m', 'add a.ts');
      return dir;
    }

    it('catches a control byte added during a rename, in staged mode', () => {
      const dir = repoWithCommittedFile();
      git(dir, 'mv', 'a.ts', 'b.ts');
      fs.appendFileSync(path.join(dir, 'b.ts'), Buffer.from('export const bad = 9;\x00\n', 'binary'));
      git(dir, 'add', '-A');
      // Guard against the fixture silently not being a rename any more.
      expect(git(dir, 'diff', '--cached', '--name-status')).toMatch(/^R/);
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('b.ts');
    });

    it('catches a control byte added during a rename, in --changed mode', () => {
      const dir = repoWithCommittedFile();
      const base = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'mv', 'a.ts', 'b.ts');
      fs.appendFileSync(path.join(dir, 'b.ts'), Buffer.from('export const bad = 9;\x00\n', 'binary'));
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'rename and add a NUL');
      const r = runGuard(dir, ['--changed', base]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('b.ts');
    });

    it('passes a clean rename', () => {
      const dir = repoWithCommittedFile();
      git(dir, 'mv', 'a.ts', 'b.ts');
      git(dir, 'add', '-A');
      expect(runGuard(dir).status).toBe(0);
    });
  });

  it('finds a control byte beyond the first read chunk', () => {
    // Content is read in bounded chunks rather than slurped, so a hit late in a large file
    // must still be found. 176KB spans three 64KB chunks.
    const { dir } = makeRepo();
    write(dir, 'big.ts', 'export const pad = 1;\n'.repeat(8000) + 'export const bad = 2;\x00\n');
    expect(fs.statSync(path.join(dir, 'big.ts')).size).toBeGreaterThan(65536 * 2);
    git(dir, 'add', 'big.ts');
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('big.ts');
  });

  it('reads the staged blob, not the worktree copy', () => {
    // Stage a bad blob, then clean the file on disk without re-staging. The commit would
    // still carry the bad blob, so scanning the worktree copy would wave it through.
    const { dir } = makeRepo();
    write(dir, 'f.ts', 'export const bad = 1;\x00\n');
    git(dir, 'add', 'f.ts');
    write(dir, 'f.ts', 'export const clean = 1;\n');
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('f.ts');
  });
});

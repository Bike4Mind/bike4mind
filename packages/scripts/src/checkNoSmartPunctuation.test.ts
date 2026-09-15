import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Behaviour tests for scripts/check-no-smart-punctuation.sh (the guard added for #1458).
 *
 * Each case builds a throwaway git repo under the OS temp dir and runs the real script against
 * it, so the assertions cover the shipped shell rather than a reimplementation. Nothing here
 * touches the working repo. Same shape as checkNoControlBytes.test.ts, which guards the other
 * half of the CLAUDE.md ASCII-only rule -- keep the two in sync.
 *
 * Every fixture builds its smart punctuation from escapes (EM below, not a literal character).
 * A literal would make this file violate the very rule it tests, so the guard would reject its
 * own test suite the moment it was staged.
 *
 * Must stay in sync with the guard's three modes: default/--staged, --changed <base>, --all.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GUARD = path.join(REPO_ROOT, 'scripts', 'check-no-smart-punctuation.sh');

// Absolute, because the fail-closed case stubs PATH down to git only -- a bare 'bash' would then
// fail to spawn at all, which is a different failure than the one under test.
const BASH = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim() || '/bin/bash';

const EM = '\u2014';

/** The six characters of the rule, with the label the guard reports for each. */
const SMART: Array<[label: string, char: string]> = [
  ['U+2013 en-dash', '\u2013'],
  ['U+2014 em-dash', '\u2014'],
  ['U+2018 left quote', '\u2018'],
  ['U+2019 right quote', '\u2019'],
  ['U+201C left dquote', '\u201C'],
  ['U+201D right dquote', '\u201D'],
];

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-guard-'));
  sandboxes.push(dir);
  git(dir, 'init', '-q', '.');
  git(dir, 'config', 'user.email', 'test@example.test');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

function write(dir: string, name: string, contents: string) {
  fs.writeFileSync(path.join(dir, name), contents, 'utf8');
}

/** A PATH containing only git, so the guard can diff but not scan. */
function makeStubBin(): string {
  const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-guard-bin-'));
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

describe('check-no-smart-punctuation.sh', () => {
  it('is present and executable', () => {
    expect(fs.existsSync(GUARD)).toBe(true);
    // Mode matters: the hook and CI both invoke it, and a non-executable guard is a silent no-op risk.
    expect(fs.statSync(GUARD).mode & 0o111).toBeGreaterThan(0);
  });

  describe('staged mode (the pre-commit hook path)', () => {
    it.each(SMART)('rejects %s and names it in the report', (label, char) => {
      const { dir } = makeRepo();
      write(dir, 'bad.ts', `// a title ${char} with smart punctuation\n`);
      git(dir, 'add', 'bad.ts');
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('bad.ts:1:');
      // The whole point of the guard is that these characters are invisible, so the report has
      // to name the offender rather than echo the line back unchanged.
      expect(r.stdout).toContain(`[${label}]`);
    });

    it('allows ASCII punctuation, which is what the rule asks for', () => {
      const { dir } = makeRepo();
      write(dir, 'ok.ts', `// a title - with a hyphen, 'single' and "double" quotes\n`);
      git(dir, 'add', 'ok.ts');
      expect(runGuard(dir).status).toBe(0);
    });

    it('passes when nothing is staged', () => {
      const { dir } = makeRepo();
      expect(runGuard(dir).status).toBe(0);
    });

    it('ignores smart punctuation outside .ts/.tsx, since that is the declared scope', () => {
      const { dir } = makeRepo();
      write(dir, 'notes.md', `docs prose ${EM} with an em-dash\n`);
      git(dir, 'add', 'notes.md');
      expect(runGuard(dir).status).toBe(0);
    });

    it.each(['C.tsx', 'm.mts', 'c.cts'])('rejects smart punctuation in %s', name => {
      const { dir } = makeRepo();
      write(dir, name, `// hello ${EM} world\n`);
      git(dir, 'add', name);
      expect(runGuard(dir).status).toBe(1);
    });

    it('reads the staged blob, not the worktree copy', () => {
      // Stage a bad blob, then clean the file on disk without re-staging. The commit would still
      // carry the bad blob, so scanning the worktree copy would wave it through.
      const { dir } = makeRepo();
      write(dir, 'f.ts', `// bad ${EM} dash\n`);
      git(dir, 'add', 'f.ts');
      write(dir, 'f.ts', '// clean - dash\n');
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('f.ts');
    });

    it('reports the correct line number across several hunks', () => {
      const { dir } = makeRepo();
      const lines = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`);
      write(dir, 'many.ts', lines.join('\n') + '\n');
      git(dir, 'add', 'many.ts');
      git(dir, 'commit', '-q', '-m', 'add many.ts');

      lines[4] = `// early ${EM} hit`;
      lines[30] = `// late ${EM} hit`;
      write(dir, 'many.ts', lines.join('\n') + '\n');
      git(dir, 'add', 'many.ts');

      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('many.ts:5:');
      expect(r.stdout).toContain('many.ts:31:');
    });
  });

  // Added CONTENT that looks like diff METADATA. The guard parses a diff, so a line whose content
  // starts with '++ ' arrives as '+++ ...' -- indistinguishable from a file header unless the
  // parser tracks state. The '/dev/null' payload is the dangerous one: read as a header it means
  // "file deleted", which blanks the current path and silently skips every later added line in
  // that file. That is a false clean pass, and a .ts holding a diff as a fixture or docs string
  // reaches it without anyone trying.
  describe('added content that mimics diff metadata', () => {
    it.each([
      ['++ /dev/null', '++ /dev/null'],
      ['++ b/elsewhere.ts', '++ b/elsewhere.ts'],
      ['@@ -1 +1 @@', '@@ -1 +1 @@'],
      ['diff --git a/x.ts b/x.ts', 'diff --git a/x.ts b/x.ts'],
    ])('still catches a violation after an added line reading "%s"', (_label, payload) => {
      const { dir } = makeRepo();
      write(dir, 'fixture.ts', ['export const doc = `', payload, `// prose ${EM} here`, '`;'].join('\n') + '\n');
      git(dir, 'add', 'fixture.ts');
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      // Right file AND right line: a mis-parsed header would either skip the line or attribute it
      // to whatever path the payload named.
      expect(r.stdout).toContain('fixture.ts:3:');
    });
  });

  // The reason this guard is line-level while the control-byte guard is file-level: ~645 tracked
  // .ts/.tsx files already carry smart punctuation, so a file-level guard would fail on most PRs.
  describe('line-level scoping (why -U0 is load-bearing)', () => {
    function repoWithPreExisting() {
      const { dir, base } = makeRepo();
      write(
        dir,
        'legacy.ts',
        ['export const a = 1;', `// legacy prose ${EM} untouched`, 'export const b = 2;'].join('\n') + '\n'
      );
      git(dir, 'add', 'legacy.ts');
      git(dir, 'commit', '-q', '-m', 'add a file with pre-existing smart punctuation');
      return { dir, base };
    }

    it('passes when an edit leaves the offending line untouched', () => {
      const { dir } = repoWithPreExisting();
      write(
        dir,
        'legacy.ts',
        ['export const a = 99;', `// legacy prose ${EM} untouched`, 'export const b = 2;'].join('\n') + '\n'
      );
      git(dir, 'add', 'legacy.ts');
      expect(runGuard(dir).status).toBe(0);
    });

    // Directly pins -U0: with any context lines in the diff, the pre-existing em-dash one line
    // away would be scanned and the commit would fail for something the author did not write.
    it('passes when the edit is on the line immediately adjacent', () => {
      const { dir } = repoWithPreExisting();
      write(
        dir,
        'legacy.ts',
        ['export const a = 1;', `// legacy prose ${EM} untouched`, 'export const b = 42;'].join('\n') + '\n'
      );
      git(dir, 'add', 'legacy.ts');
      expect(runGuard(dir).status).toBe(0);
    });

    it('passes when the offending line is being DELETED', () => {
      const { dir } = repoWithPreExisting();
      write(dir, 'legacy.ts', ['export const a = 1;', 'export const b = 2;'].join('\n') + '\n');
      git(dir, 'add', 'legacy.ts');
      expect(runGuard(dir).status).toBe(0);
    });

    it('still fails when the offending line itself is edited', () => {
      const { dir } = repoWithPreExisting();
      write(
        dir,
        'legacy.ts',
        ['export const a = 1;', `// legacy prose ${EM} now reworded`, 'export const b = 2;'].join('\n') + '\n'
      );
      git(dir, 'add', 'legacy.ts');
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('legacy.ts:2:');
    });
  });

  describe('--changed mode (the CI path)', () => {
    it('rejects smart punctuation introduced in a commit after the base', () => {
      const { dir, base } = makeRepo();
      write(dir, 'added.ts', `// later ${EM} dash\n`);
      git(dir, 'add', 'added.ts');
      git(dir, 'commit', '-q', '-m', 'add a file with an em-dash');
      expect(runGuard(dir, ['--changed', base]).status).toBe(1);
    });

    it('passes when the commits after the base are clean', () => {
      const { dir, base } = makeRepo();
      write(dir, 'fine.ts', '// fine - dash\n');
      git(dir, 'add', 'fine.ts');
      git(dir, 'commit', '-q', '-m', 'add a clean file');
      expect(runGuard(dir, ['--changed', base]).status).toBe(0);
    });

    // Both "scanned everything" and "scanned nothing" exit 0 on a clean tree, so an unresolvable
    // base must visibly widen the scan instead of quietly passing.
    it.each([
      ['an empty base', ''],
      ['an all-zero base, as a new-branch push sends', '0'.repeat(40)],
      ['a nonexistent sha', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
    ])('falls back to a full scan given %s', (_label, base) => {
      const { dir } = makeRepo();
      write(dir, 'added.ts', `// later ${EM} dash\n`);
      git(dir, 'add', 'added.ts');
      git(dir, 'commit', '-q', '-m', 'add a file with an em-dash');
      const r = runGuard(dir, ['--changed', base]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('unresolvable');
    });
  });

  // Anything that makes git classify a file as binary emits "Binary files ... differ" with no
  // +++/@@ records, so the scan would see nothing and exit 0 on a real violation. `--text` forces
  // a readable body. Both routes into that state are pinned: NUL content, and a tracked
  // .gitattributes `-diff` entry, which needs no NUL at all.
  describe('binary-classified files must still be scanned (--text)', () => {
    it('catches a violation in a NUL-containing .ts', () => {
      const { dir } = makeRepo();
      fs.writeFileSync(path.join(dir, 'bin.ts'), Buffer.from(`// bad ${EM} dash\0 with a NUL\n`, 'utf8'));
      git(dir, 'add', 'bin.ts');
      // Guard against the fixture silently not being binary any more, which would void the test.
      expect(git(dir, 'diff', '--cached')).toContain('Binary files');
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('bin.ts:1:');
    });

    // The route with no backstop: `*.ts -diff` marks every .ts non-diffable, so the file needs no
    // NUL, and the control-byte guard sees nothing wrong with it either (an em-dash is not a
    // control byte). One line in a normal tracked file would otherwise disable this guard
    // entirely, in both the hook and CI.
    it('catches a violation despite a tracked .gitattributes "-diff" entry', () => {
      const { dir } = makeRepo();
      write(dir, '.gitattributes', '*.ts -diff\n');
      write(dir, 'bad.ts', `// a title ${EM} with an em-dash\n`);
      git(dir, 'add', '-A');
      expect(git(dir, 'diff', '--cached', '--', 'bad.ts')).toContain('Binary files');
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('bad.ts:1:');
    });
  });

  // Every other case stages a single file, so the `diff --git` state reset is never exercised
  // against a real second file header. Without the reset, a violation in the second file is
  // reported under the FIRST file's path: the commit still fails, but it sends the author to the
  // wrong file.
  it('attributes a violation to the right file in a multi-file diff', () => {
    const { dir } = makeRepo();
    write(dir, 'a-clean.ts', '// entirely - ASCII\n');
    write(dir, 'b-bad.ts', ['export const x = 1;', `// prose ${EM} here`].join('\n') + '\n');
    git(dir, 'add', '-A');
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('b-bad.ts:2:');
    expect(r.stdout).not.toContain('a-clean.ts');
  });

  // The two guards are wired side by side in both entry points, and this guard's header comment
  // reasons about the pair. A future PR dropping or reordering one should break a test rather than
  // quietly reduce coverage.
  describe('both guards stay co-wired in the hook and CI', () => {
    // Matches the `bash scripts/...` invocation rather than the bare filename, so a comment that
    // merely mentions a guard cannot satisfy the assertion while the call itself is gone.
    it.each(['.husky/pre-commit', '.github/workflows/ci.yml'])('%s invokes both guards', relPath => {
      const contents = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
      expect(contents).toMatch(/bash\s+scripts\/check-no-control-bytes\.sh/);
      expect(contents).toMatch(/bash\s+scripts\/check-no-smart-punctuation\.sh/);
    });
  });

  describe('--all mode', () => {
    it('rejects a tracked file containing smart punctuation anywhere', () => {
      const { dir } = makeRepo();
      write(dir, 'legacy.ts', ['export const a = 1;', `// prose ${EM} here`].join('\n') + '\n');
      git(dir, 'add', 'legacy.ts');
      git(dir, 'commit', '-q', '-m', 'add a file with an em-dash');
      const r = runGuard(dir, ['--all']);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('legacy.ts:2:');
    });

    it('passes on a fully ASCII tree', () => {
      const { dir } = makeRepo();
      write(dir, 'clean.ts', '// all - ASCII\n');
      git(dir, 'add', 'clean.ts');
      git(dir, 'commit', '-q', '-m', 'add a clean file');
      expect(runGuard(dir, ['--all']).status).toBe(0);
    });
  });

  // Any of these silently changes the diff header shape. A parser that stops recognising the
  // header does not error -- it finds no filenames and passes everything, the worst outcome for
  // a guard, so each config is pinned rather than assumed.
  describe('hostile git config must not blind the guard', () => {
    it.each([
      ['diff.noprefix', 'true'],
      ['diff.mnemonicPrefix', 'true'],
      ['core.quotePath', 'true'],
      ['diff.external', '/bin/false'],
      ['diff.srcPrefix', 'src/'],
      ['diff.dstPrefix', 'dst/'],
    ])('still catches a violation with %s=%s', (key, value) => {
      const { dir } = makeRepo();
      git(dir, 'config', key, value);
      write(dir, 'bad.ts', `// bad ${EM} dash\n`);
      git(dir, 'add', 'bad.ts');
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('bad.ts:1:');
    });

    it('reports a non-ASCII path unquoted', () => {
      // With core.quotePath on (git's default), a non-ASCII path is emitted C-quoted as
      // "caf\303\251.ts". The guard forces it off so the report names a path a human can use.
      const { dir } = makeRepo();
      git(dir, 'config', 'core.quotePath', 'true');
      write(dir, 'caf\u00e9.ts', `// bad ${EM} dash\n`);
      git(dir, 'add', '-A');
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('café.ts:1:');
    });
  });

  describe('renames', () => {
    // Git detects renames by default and emits a rename-plus-edit as one R<score> record. The
    // guard deliberately uses no --diff-filter, so no record shape can be dropped -- an ACM
    // filter dropping R is the exact bug that bit the control-byte guard.
    const body = Array.from({ length: 5 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';

    function repoWithCommittedFile() {
      const { dir } = makeRepo();
      write(dir, 'a.ts', body);
      git(dir, 'add', 'a.ts');
      git(dir, 'commit', '-q', '-m', 'add a.ts');
      return dir;
    }

    it('catches smart punctuation added during a rename', () => {
      const dir = repoWithCommittedFile();
      git(dir, 'mv', 'a.ts', 'b.ts');
      fs.appendFileSync(path.join(dir, 'b.ts'), `// added ${EM} during rename\n`);
      git(dir, 'add', '-A');
      // Guard against the fixture silently not being a rename any more.
      expect(git(dir, 'diff', '--cached', '--name-status')).toMatch(/^R/);
      const r = runGuard(dir);
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

  describe('fail-closed behaviour', () => {
    it('fails closed when perl is unavailable rather than reporting clean', () => {
      const { dir } = makeRepo();
      write(dir, 'bad.ts', `// bad ${EM} dash\n`);
      git(dir, 'add', 'bad.ts');

      const stubBin = makeStubBin();
      const r = runGuard(dir, [], { PATH: stubBin });
      expect(r.status).toBe(1);
      expect(`${r.stdout}${r.stderr}`).toContain('perl not found');
    });

    // Distinct from "perl not found": perl exists, so the command -v check passes, but the scan
    // itself dies. That must not read as a clean tree either.
    it('fails closed when perl exists but exits non-zero', () => {
      const { dir } = makeRepo();
      write(dir, 'bad.ts', `// bad ${EM} dash\n`);
      git(dir, 'add', 'bad.ts');

      const stubBin = makeStubBin();
      const stub = path.join(stubBin, 'perl');
      fs.writeFileSync(stub, '#!/bin/sh\nexit 3\n');
      fs.chmodSync(stub, 0o755);

      const r = runGuard(dir, [], { PATH: stubBin });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain('failing closed');
    });

    // Both modes, because staged mode is the one the hook actually runs: --all resolves the empty
    // tree first and fails there, while staged mode fails in `git diff --cached` itself.
    it.each([
      ['--all mode', ['--all']],
      ['staged mode', [] as string[]],
    ])('fails closed outside a git repo rather than passing an empty diff (%s)', (_label, args) => {
      // A process substitution would hide the git failure and yield a bogus clean pass; the
      // pipeline must surface it.
      const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-guard-norepo-'));
      sandboxes.push(notARepo);
      const r = runGuard(notARepo, args);
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
  });

  // The diff is piped to perl on stdin and no path ever reaches @ARGV, where perl's diamond
  // operator would do a magic 2-argument open and run a command embedded in a filename. That
  // safety is structural here rather than defensive, so it is pinned: a refactor toward opening
  // files by name has to break this test.
  it('does not execute a command embedded in a filename', () => {
    const { dir } = makeRepo();
    const hostile = '|touch PWNED;.ts';
    write(dir, hostile, `// bad ${EM} dash\n`);
    git(dir, 'add', '-A');
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(hostile);
    expect(fs.existsSync(path.join(dir, 'PWNED'))).toBe(false);
  });
});

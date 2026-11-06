import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { permissionProtectedLocations } from '../protectedLocations';
import { compileRule, parseRule, PermissionRuleSet, type CompiledRule } from '../permissions/rules';
import { resolveSubject } from '../permissions/resolveSubject';
import { permissionSubject } from '../permissions/subject';
import { shellApproval } from './shellTools';
import type { ToolContext } from './types';

vi.mock('./userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('./userPath')>()),
  resolveUserPath: vi.fn(async () => process.env.PATH ?? ''),
}));

const PROGRAMS = ['cat', 'ls', 'grep', 'git', 'find', 'rg', 'xargs', 'sed', 'npx', 'cp', 'wc', 'tar'];

/** Commands that ran unasked on main and must still run as the mode allows, in a repository with a large node_modules. */
describe('commands main ran unasked', () => {
  let base: string;
  let proj: string;
  let userData: string;
  let rules: PermissionRuleSet;
  let permissionRoots: readonly string[];
  const exists = (path: string): Promise<boolean> =>
    stat(path).then(
      () => true,
      () => false
    );

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-regressions-')));
    const home = join(base, 'home');
    proj = join(home, 'proj');
    userData = join(home, '.config', 'Bike4Mind');
    for (const folder of [
      userData,
      join(proj, '.claude', 'agents'),
      join(proj, '.claude', 'commands'),
      join(proj, 'src'),
      join(base, 'bin'),
    ]) {
      await mkdir(folder, { recursive: true });
    }
    await writeFile(join(proj, '.claude', 'settings.json'), '{}');
    await writeFile(join(proj, '.claude', 'agents', 'x.md'), 'x');
    await writeFile(join(proj, '.claude', 'commands', 'x.md'), 'x');
    await writeFile(join(proj, 'src', 'a.ts'), 'foo a');
    await writeFile(join(proj, 'a'), 'a');
    await writeFile(join(proj, '.gitignore'), 'node_modules\n');
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    const git = (repo: string, ...args: string[]): void => {
      execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
        env,
      });
    };
    git(proj, 'init', '-q', '-b', 'main');
    git(proj, 'add', '-A');
    git(proj, 'commit', '-qm', 'first');
    git(proj, 'checkout', '-qb', 'other');
    await writeFile(join(proj, 'src', 'c.ts'), 'c');
    git(proj, 'add', '-A');
    git(proj, 'commit', '-qm', 'other');
    git(proj, 'checkout', '-q', 'main');
    await writeFile(join(proj, 'src', 'a.ts'), 'foo b');
    // More entries than a walk reads, as a pnpm node_modules has, with a link git does not track.
    for (let folder = 0; folder < 121; folder++) {
      await mkdir(join(proj, 'node_modules', `p${folder}`), { recursive: true });
      await Promise.all(
        Array.from({ length: 100 }, (_, file) => writeFile(join(proj, 'node_modules', `p${folder}`, `f${file}.js`), ''))
      );
    }
    await mkdir(join(proj, 'node_modules', '.pnpm', 'q'), { recursive: true });
    await symlink('.pnpm/q', join(proj, 'node_modules', 'q'));
    // crepo checks settings out with CRLF, as core.autocrlf does on Windows.
    const crepo = join(proj, 'crepo');
    await mkdir(join(crepo, '.claude'), { recursive: true });
    git(crepo, 'init', '-q', '-b', 'main');
    await writeFile(join(crepo, '.claude', 'settings.json'), '{\r\n}\r\n');
    git(crepo, '-c', 'core.autocrlf=true', 'add', '-A');
    git(crepo, 'commit', '-qm', 'first');
    git(crepo, 'config', 'core.autocrlf', 'true');
    // prepo is a treeless partial clone whose missing trees would come from a host through core.sshCommand.
    git(proj, 'config', 'uploadpack.allowFilter', 'true');
    execFileSync('git', ['clone', '-q', '--filter=tree:0', '--no-checkout', `file://${proj}`, join(proj, 'prepo')]);
    git(join(proj, 'prepo'), 'remote', 'set-url', 'origin', 'ssh://example.invalid/r');
    git(join(proj, 'prepo'), 'config', 'core.sshCommand', `touch ${join(base, 'fetched')}; false`);
    execFileSync('tar', ['-cf', 'clean.tar', 'src'], { cwd: proj });
    // A tar on PATH that logs each call, and a decoy in the project that only a lookup from the folder would run.
    const realTar = execFileSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();
    await writeFile(
      join(base, 'bin', 'tar'),
      `#!/bin/sh\necho "$@" >> ${join(base, 'tar-calls')}\nexec ${realTar} "$@"\n`
    );
    await writeFile(join(proj, 'tar'), `#!/bin/sh\ntouch ${join(base, 'local-tar')}\nexit 1\n`);
    await chmod(join(base, 'bin', 'tar'), 0o755);
    await chmod(join(proj, 'tar'), 0o755);
    await mkdir(join(base, 'tmp'));
    vi.stubEnv('TMPDIR', join(base, 'tmp'));
    vi.stubEnv('HOME', home);
    permissionRoots = permissionProtectedLocations(userData, home, join(base, 'managed'), { warn: () => {} }).paths();
    const compiled: CompiledRule[] = [];
    for (const program of PROGRAMS) {
      const parsed = parseRule(`Bash(${program}:*)`, { native: true });
      if (!parsed.ok) throw new Error(parsed.reason);
      const rule = compileRule(parsed.rule, 'allow', { id: 'test', label: 'Test' }, { home, root: proj, cwd: proj });
      if (rule) compiled.push(rule);
    }
    rules = new PermissionRuleSet(compiled, () => permissionRoots);
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(base, { recursive: true, force: true });
  });

  const judge = async (command: string, folder = '') => {
    const cwd = join(proj, folder);
    const context: ToolContext = {
      roots: [proj],
      workingDirectory: cwd,
      signal: new AbortController().signal,
      protectedPaths: [userData],
      uncoverablePaths: permissionRoots,
    };
    const prompt = await shellApproval('bash_execute', { command, cwd }, context);
    const subject = await resolveSubject(
      permissionSubject({ name: 'bash_execute', input: { command } }, prompt, context)
    ).catch(() => null);
    return {
      auto: !prompt.askInAuto && (prompt.always?.directories ?? []).length === 0,
      full: !prompt.askInFull,
      allowed: subject !== null && rules.evaluate(subject).decision === 'allow',
    };
  };

  const unasked = { auto: true, full: true, allowed: true };
  // On main the rules floor already refused any command naming `.claude`; only auto and full ran it.
  const unaskedNamingClaude = { auto: true, full: true, allowed: false };

  it.each([
    ["find . -name '*.ts' | xargs grep -l a", '', unasked],
    ["find . -name '*.ts' -not -path './node_modules/*' | xargs grep -l a", '', unasked],
    ['rg -l foo | xargs cat', '', unasked],
    ['git ls-files | xargs wc -l', '', unasked],
    ["rg -l foo src | xargs sed -i 's/a/b/'", '', unasked],
    ['grep -rl foo src | xargs sed -i s/a/b/', '', unasked],
    ['cat .claude/agents/x.md', '', unaskedNamingClaude],
    ['ls -la .claude/', '', unaskedNamingClaude],
    ['grep -r hooks .claude', '', unaskedNamingClaude],
    ['git diff .claude/settings.json', '', unaskedNamingClaude],
    ['git log -- .claude', '', unaskedNamingClaude],
    ['git add .claude/commands/x.md', '', unaskedNamingClaude],
    ['cp a .claude/commands/y.md', '', unaskedNamingClaude],
    ['git stash', 'crepo', unasked],
    ['git reset --hard', 'crepo', unasked],
  ])('decides %s (in proj/%s) as main did', async (command, folder, expected) => {
    expect(await judge(command, folder)).toEqual(expected);
  });

  it('asks before xargs hands what git diff lists to a writing program', async () => {
    expect(await judge('git diff --name-only | xargs npx prettier --write')).toEqual({
      auto: false,
      full: false,
      allowed: false,
    });
  });

  it('asks before xargs hands what a lister finds under settings to a writing program', async () => {
    expect(await judge("rg -l foo | xargs sed -i 's/a/b/'")).toMatchObject({ auto: false, full: false });
  });

  it('fetches nothing for a partial clone while it compares a checkout', async () => {
    await judge('git checkout origin/other', 'prepo');

    expect(await exists(join(base, 'fetched'))).toBe(false);
  });

  it('lists an archive with the tar on PATH, never one in the project or one on another host', async () => {
    const path = process.env.PATH ?? '';
    vi.stubEnv('PATH', `.:${join(base, 'bin')}:${path}`);
    try {
      expect(await judge('tar -xf clean.tar')).toMatchObject({ full: true, allowed: true });
      const started = Date.now();
      await judge('tar -xf host.example:x');
      await judge('tar -xf -');
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      vi.stubEnv('PATH', path);
    }
    const calls = await readFile(join(base, 'tar-calls'), 'utf8');

    expect(calls).toContain('clean.tar');
    expect(calls).not.toContain('host.example');
    expect(calls).not.toMatch(/--file=-( |$)/m);
    expect(await exists(join(base, 'local-tar'))).toBe(false);
  });
});

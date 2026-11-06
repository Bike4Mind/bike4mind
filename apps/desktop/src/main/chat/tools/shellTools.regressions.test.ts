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

const PROGRAMS = [
  'cat',
  'ls',
  'grep',
  'git',
  'find',
  'rg',
  'xargs',
  'sed',
  'npx',
  'cp',
  'wc',
  'tar',
  'echo',
  'printf',
  'rm',
];

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
      join(proj, 'bin2'),
      join(base, 'bin'),
    ]) {
      await mkdir(folder, { recursive: true });
    }
    await writeFile(join(proj, '.claude', 'settings.json'), '{"hooks": {}}');
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
    const repository = async (name: string, files: Record<string, string>): Promise<string> => {
      const repo = join(proj, name);
      for (const [path, content] of Object.entries(files)) {
        await mkdir(join(repo, path, '..'), { recursive: true });
        await writeFile(join(repo, path), content);
      }
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'first');
      return repo;
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
    // lrepo has settings committed with LF and rewritten with CRLF, with no autocrlf to fold them back.
    const lrepo = await repository('lrepo', { '.claude/settings.json': '{\n}\n' });
    await writeFile(join(lrepo, '.claude', 'settings.json'), '{\r\n}\r\n');
    // srepo has settings changed in the work tree; drepo has a tracked folder a link to the app's data replaced.
    const srepo = await repository('srepo', { '.claude/settings.json': '{}', 'src/b.ts': 'b' });
    await writeFile(join(srepo, '.claude', 'settings.json'), '{"x": 1}');
    await writeFile(join(srepo, 'src', 'b.ts'), 'b2');
    const drepo = await repository('drepo', { 'docs/secret': 's', 'src/b.ts': 'b' });
    await rm(join(drepo, 'docs'), { recursive: true });
    await symlink(userData, join(drepo, 'docs'));
    // prepo is a treeless partial clone whose missing trees would come from a host through core.sshCommand.
    git(proj, 'config', 'uploadpack.allowFilter', 'true');
    execFileSync('git', ['clone', '-q', '--filter=tree:0', '--no-checkout', `file://${proj}`, join(proj, 'prepo')]);
    git(join(proj, 'prepo'), 'remote', 'set-url', 'origin', 'ssh://example.invalid/r');
    git(join(proj, 'prepo'), 'config', 'core.sshCommand', `touch ${join(base, 'fetched')}; false`);
    execFileSync('tar', ['-cf', 'clean.tar', 'src'], { cwd: proj });
    execFileSync('tar', ['-czf', 'clean.tar.gz', 'src'], { cwd: proj });
    // A tar on PATH that logs each call, and decoys in the project that only a lookup from the project would run.
    const realTar = execFileSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();
    await writeFile(
      join(base, 'bin', 'tar'),
      `#!/bin/sh\necho "$@" >> ${join(base, 'tar-calls')}\nexec ${realTar} "$@"\n`
    );
    await writeFile(join(proj, 'tar'), `#!/bin/sh\ntouch ${join(base, 'local-tar')}\nexit 1\n`);
    await writeFile(join(proj, 'gzip'), `#!/bin/sh\ntouch ${join(base, 'local-gzip')}\nexit 1\n`);
    await writeFile(join(proj, 'bin2', 'gzip'), `#!/bin/sh\ntouch ${join(base, 'project-gzip')}\nexit 1\n`);
    for (const program of [
      join(base, 'bin', 'tar'),
      join(proj, 'tar'),
      join(proj, 'gzip'),
      join(proj, 'bin2', 'gzip'),
    ]) {
      await chmod(program, 0o755);
    }
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
  const asks = { auto: false, full: false };

  it.each([
    ["find . -name '*.ts' | xargs grep -l a", '', unasked],
    ["find . -name '*.ts' -not -path './node_modules/*' | xargs grep -l a", '', unasked],
    ["find . -name '*.ts' -mtime -1 | xargs cat", '', unasked],
    ['find . -name "*.ts" | xargs npx prettier --write', '', unasked],
    ['find src -name "*.ts" -exec sed -i s/a/b/ {} +', '', unasked],
    ['rg -l foo | xargs cat', '', unasked],
    ["rg -l foo | xargs sed -i 's/a/b/'", '', unasked],
    ['rg -l hooks | xargs sed -i s/a/b/', '', unasked],
    ["rg -l foo src | xargs sed -i 's/a/b/'", '', unasked],
    ['grep -rl foo src | xargs sed -i s/a/b/', '', unasked],
    ['grep -rl foo . | xargs sed -i s/foo/bar/g', '', unasked],
    ['git ls-files | xargs wc -l', '', unasked],
    ['git ls-files "*.ts" | xargs npx prettier --write', '', unasked],
    ['git ls-files -m | xargs npx prettier --write', '', unasked],
    ['git grep -l foo | xargs sed -i s/a/b/', '', unasked],
    ['git diff --name-only | xargs npx prettier --write', '', unasked],
    ['git diff --name-only | xargs cat', '', unasked],
    ['git diff --name-only --cached | xargs cat', '', unasked],
    ['git diff --name-only HEAD | xargs wc -l', '', unasked],
    ['ls src/*.ts | xargs wc -l', '', unasked],
    ['echo src/a.ts | xargs rm', '', unasked],
    ["printf '%s\\n' src/a.ts | xargs wc -l", '', unasked],
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

  it.each([
    ['grep -rl hooks . | xargs sed -i s/a/b/', ''],
    ['rg -l --hidden hooks | xargs sed -i s/a/b/', ''],
    ["find . -name '*.json' | xargs sed -i s/a/b/", ''],
    ["find . -name '*.json' -exec sed -i s/a/b/ {} +", ''],
    ['git ls-files | xargs sed -i s/a/b/', ''],
    ['git grep -l hooks | xargs sed -i s/a/b/', ''],
    ['echo .claude/settings.json | xargs rm', ''],
    ['git diff --name-only | xargs npx prettier --write', 'srepo'],
    ['git reset --hard', 'lrepo'],
  ])('asks before %s (in proj/%s) rewrites settings', async (command, folder) => {
    expect(await judge(command, folder)).toMatchObject(asks);
  });

  it.each(['git ls-files | xargs cat', 'git diff --name-only | xargs cat'])(
    'asks for %s as for the path a link replaced',
    async command => {
      const direct = await judge('cat docs/secret', 'drepo');

      expect(direct.auto).toBe(false);
      expect(await judge(command, 'drepo')).toMatchObject({ auto: direct.auto, full: direct.full });
    }
  );

  it('fetches nothing for a partial clone while it compares a checkout', async () => {
    await judge('git checkout origin/other', 'prepo');

    expect(await exists(join(base, 'fetched'))).toBe(false);
  });

  it('lists an archive with the tar on PATH, never one in the project or one on another host', async () => {
    const path = process.env.PATH ?? '';
    vi.stubEnv('PATH', `.:${join(proj, 'bin2')}:${join(base, 'bin')}:${path}`);
    try {
      expect(await judge('tar -xf clean.tar')).toMatchObject({ full: true, allowed: true });
      expect(await judge('tar -xf clean.tar.gz')).toMatchObject({ full: true, allowed: true });
      const started = Date.now();
      await judge('tar -xf host.example:x');
      await judge('tar -xf //host.example/share/x.tar');
      await judge('tar -xf -');
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      vi.stubEnv('PATH', path);
    }
    const calls = await readFile(join(base, 'tar-calls'), 'utf8');

    expect(calls).toContain('clean.tar.gz');
    expect(calls).not.toContain('host.example');
    expect(calls).not.toMatch(/--file=-( |$)/m);
    for (const marker of ['local-tar', 'local-gzip', 'project-gzip']) {
      expect(await exists(join(base, marker))).toBe(false);
    }
  });
});

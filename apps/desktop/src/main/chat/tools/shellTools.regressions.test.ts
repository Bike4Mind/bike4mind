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
  'pgrep',
  'docker',
  'head',
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
    // brepo tracks `w/q .claude/settings.json`, which xargs splits into `w/q` and its own `.claude/settings.json`,
    // and `w3/zX.claude/settings.jsonX`, which `xargs -d X` splits the same way.
    const brepo = await repository('brepo', {
      'w/q .claude/settings.json': '{"hooks": {}}',
      'w3/zX.claude/settings.jsonX': 'a',
      'src/b.ts': 'b',
    });
    await mkdir(join(brepo, '.claude'));
    await writeFile(join(brepo, '.claude', 'settings.json'), '{}');
    // erepo has such a name changed in the work tree; mrepo changes its settings on a side branch.
    const erepo = await repository('erepo', { 'w/q .claude/settings.json': 'a', 'src/b.ts': 'b' });
    await mkdir(join(erepo, '.claude'));
    await writeFile(join(erepo, '.claude', 'settings.json'), '{}');
    await writeFile(join(erepo, 'w', 'q .claude', 'settings.json'), 'b');
    const mrepo = await repository('mrepo', { '.claude/settings.json': '{}', 'src/b.ts': 'b' });
    git(mrepo, 'checkout', '-qb', 'side');
    await writeFile(join(mrepo, '.claude', 'settings.json'), '{"x": 1}');
    git(mrepo, 'commit', '-qam', 'side');
    git(mrepo, 'checkout', '-q', 'main');
    // arepo gives settings an attribute, which the scan's git, reading attributes from the empty tree, never sees.
    const arepo = await repository('arepo', { '.gitattributes': '.claude/** foo\n', '.claude/settings.json': '{}' });
    await writeFile(join(arepo, '.claude', 'settings.json'), '{"x": 1}');
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
    await writeFile(join(proj, 'git'), `#!/bin/sh\ntouch ${join(base, 'local-git')}\nexit 1\n`);
    await writeFile(join(proj, 'bin2', 'git'), `#!/bin/sh\ntouch ${join(base, 'project-git')}\nexit 1\n`);
    for (const program of [
      join(base, 'bin', 'tar'),
      join(proj, 'tar'),
      join(proj, 'gzip'),
      join(proj, 'bin2', 'gzip'),
      join(proj, 'git'),
      join(proj, 'bin2', 'git'),
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
    ['ls | xargs cat', '', unasked],
    ['ls src | xargs cat', '', unasked],
    ["find . -path ./node_modules -prune -o -name '*.ts' -print | xargs cat", '', unasked],
    ['git status && git ls-files src | xargs wc -l', '', unasked],
    ['pgrep node | xargs kill', '', unasked],
    ['docker ps -q | xargs docker stop', '', unasked],
    ['git branch --merged | xargs git branch -d', '', unasked],
    ["find src -name '*.ts' | xargs -d '\\n' sed -i s/a/b/", '', unasked],
    ['git diff --name-only -- src | xargs wc -l', 'srepo', unasked],
    ['git ls-files src | xargs -I{} wc -l {}', '', unasked],
    ["find src -name '*.ts' | xargs -I{} sed -i s/a/b/ {}", '', unasked],
    ['docker ps -q | xargs -I{} docker stop {}', '', unasked],
    ["find . -name node_modules -type d -prune -exec rm -rf '{}' +", '', unasked],
    ["git diff --name-only | grep '\\.ts$' | xargs wc -l", '', unasked],
    ["grep 'a$' src/a.ts", '', unasked],
    ["git status  # what's staged", '', unasked],
    ["# Check what's changed\ngit status", '', unasked],
    ["git log --oneline -5 # don't page", '', unasked],
    ['git diff --name-only src | xargs wc -l', '', unasked],
    ['git diff --name-only src/ | xargs wc -l', '', unasked],
    ["find src -name '*.ts' 2>/dev/null | xargs cat", '', unasked],
    ['git ls-files | grep -v x | xargs wc -l', '', unasked],
    ["find src -name '*.ts' | head -5 | xargs sed -i s/a/b/", '', unasked],
    ['git branch --merged | grep -v main | xargs git branch -d', '', unasked],
    ['git diff --name-only main...other | xargs sed -i s/a/b/', '', unasked],
    ['git diff --name-only main..other | xargs sed -i s/a/b/', '', unasked],
    ['git ls-files -z w | xargs -0 sed -i s/a/b/', 'brepo', unasked],
    ['rg -l0 hooks w | xargs -0 sed -i s/a/b/', 'brepo', unasked],
    ["find w -name '*.json' -print0 | xargs -0 sed -i s/a/b/", 'brepo', unasked],
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
    ['rg -l hooks | xargs sed -i s/a/b/', ''],
    ["rg -l -g '*' hooks | xargs sed -i s/a/b/", ''],
    ["rg --files -g '*' | xargs sed -i s/a/b/", ''],
    ['export RIPGREP_CONFIG_PATH=/dev/null; rg -l foo | xargs sed -i s/a/b/', ''],
    ["grep -rl hooks --exclude='*.json' --include='settings.json' . | xargs sed -i s/a/b/", ''],
    [`grep -rli hook${String.fromCharCode(0x17f)} . | xargs sed -i s/a/b/`, ''],
    ['find . -print -name zzz | xargs truncate -s 0', ''],
    ['find . -exec truncate -s 0 {} + -name zzz', ''],
    ["find . -maxdepth 1 -name '.c*' | xargs rm -rf", ''],
    ["find . -maxdepth 1 -name '.c*' | xargs chmod -R 000", ''],
    ["find . -maxdepth 1 -name '.c*' -exec rm -rf {} +", ''],
    ["find . -maxdepth 1 -name '.c*' -exec chmod -R 000 {} +", ''],
    ["find . -name '*.ts' -exec env sh -c 'echo x > .claude/settings.json' {} +", ''],
    ["find . -name '*.ts' -exec timeout 5 sh -c 'echo x > .claude/settings.json' {} +", ''],
    ["find . -name '*.ts' -exec cat {} + | xargs rm", ''],
    ['export GIT_INDEX_FILE=/tmp/x; git ls-files src | xargs sed -i s/a/b/', ''],
    ['git read-tree other && git diff --name-only --cached | xargs sed -i s/a/b/', ''],
    ['git reset -q other -- . && git ls-files src | xargs sed -i s/a/b/', ''],
    ['git add -f . && git ls-files src | xargs sed -i s/a/b/', ''],
    ["echo '!.claude' > .ignore; rg -l foo | xargs sed -i s/a/b/", ''],
    ['git ls-files w | xargs sed -i s/a/b/', 'brepo'],
    ["find w -name '*.json' | xargs sed -i s/a/b/", 'brepo'],
    ['rg -l hooks w | xargs sed -i s/a/b/', 'brepo'],
    ['grep -rl hooks w | xargs sed -i s/a/b/', 'brepo'],
    ["find w3 -name 'settings*' | xargs -d X sed -i s/a/b/", 'brepo'],
    ["find w3 -name 'settings*' | xargs -d '\\x58' sed -i s/a/b/", 'brepo'],
    ['git ls-files w3 | xargs -d X sed -i s/a/b/', 'brepo'],
    ['rg -l a w3 | xargs --delimiter=X sed -i s/a/b/', 'brepo'],
    ['git diff --name-only | xargs sed -i s/a/b/', 'erepo'],
    ['find . -depth -prune -type f | xargs sed -i s/a/b/', ''],
    ['find . -depth -prune -type f -exec sed -i s/a/b/ {} +', ''],
    ['rg -l hooks | grep json | xargs sed -i s/a/b/', ''],
    ['git diff --name-only main...side | xargs sed -i s/a/b/', 'mrepo'],
    ['find . -maxdepth 1 -type d | xargs -I{} time -o {}/settings.json du -sh {}', ''],
    ["git diff --name-only . ':(exclude,attr:!foo)' | xargs sed -i s/a/b/", 'arepo'],
  ])('asks before %s (in proj/%s) rewrites settings', async (command, folder) => {
    expect(await judge(command, folder)).toMatchObject(asks);
  });

  it.each([
    // A replace string inside a larger word names a path no lister prints.
    "find src -name '*.ts' | xargs -I{} cp {} {}.bak",
    // A fed word may be a docker option, and podman's options after the subcommand can run a program.
    'echo --cidfile=FILE | xargs docker rm',
    'podman ps -q | xargs podman stop',
    'pgrep node | xargs -I{} time -o {}/x kill {}',
    // The lister's stderr reaches xargs too.
    'rg -l foo |& xargs sed -i s/a/b/',
    'rg -l foo 2>&1 | xargs sed -i s/a/b/',
    '2>&1 rg -l foo | xargs sed -i s/a/b/',
    // rg and grep echo a pattern they cannot parse on stderr.
    "rg -l '( docs/secret x' 2>/dev/stdout | xargs sed -i s/a/b/",
    "grep -rlE '( docs/secret x' . 2>/dev/stdout | xargs sed -i s/a/b/",
    'rg -l foo 2>>/dev/stdout | xargs sed -i s/a/b/',
    'echo "main --force" | xargs git branch -d',
    'pgrep --list-full node | xargs docker stop',
  ])('asks for %s, which main ran unasked', async command => {
    expect(await judge(command)).toMatchObject(asks);
  });

  it.each([
    "grep $'a' src/a.ts",
    "grep 'a$' src/a.ts; echo $'b'",
    'echo "$(cat $\'a\')"',
    // Read as quotes, the heredoc bodies would pair up around the `$'`.
    "cat <<A\nit's\nA\necho $'b'\ncat <<B\nit's\nB",
  ])('asks for %s, which may hold an ANSI-C quote', async command => {
    expect(await judge(command)).toMatchObject(asks);
  });

  it.each([
    ['RIPGREP_CONFIG_PATH', 'rg -l foo | xargs sed -i s/a/b/', asks],
    ['RIPGREP_CONFIG_PATH', 'rg -l --no-config foo | xargs sed -i s/a/b/', unasked],
    ['GIT_INDEX_FILE', 'git ls-files src | xargs sed -i s/a/b/', asks],
  ])('with %s set decides %s', async (variable, command, expected) => {
    vi.stubEnv(variable, '/dev/null');
    try {
      expect(await judge(command)).toMatchObject(expected);
    } finally {
      vi.stubEnv(variable, undefined);
    }
  });

  it.each([
    "env sh -c 'echo x > .claude/settings.json'",
    "timeout 5 sh -c 'echo x > .claude/settings.json'",
    'python3 -c \'open(".claude/settings.json", "w")\'',
  ])('decides find -exec %s as its xargs form', async program => {
    expect(await judge(`find . -name '*.ts' -exec ${program} {} +`)).toEqual(
      await judge(`find . -name '*.ts' | xargs ${program}`)
    );
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

  it('reads a settings file swapped for a FIFO without waiting on it', async () => {
    const frepo = join(proj, 'frepo');
    await mkdir(join(frepo, '.claude'), { recursive: true });
    execFileSync('mkfifo', [join(frepo, '.claude', 'settings.json')]);

    const started = Date.now();
    expect(await judge('rg -l foo | xargs sed -i s/a/b/', 'frepo')).toMatchObject(asks);
    // A blocked read only ends at the 5 s scan deadline.
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('runs git and archive programs from PATH outside the project, never one in it or one on another host', async () => {
    const path = process.env.PATH ?? '';
    vi.stubEnv('PATH', `.:${join(proj, 'bin2')}:${join(base, 'bin')}:${path}`);
    try {
      expect(await judge('git ls-files src | xargs wc -l')).toEqual(unasked);
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
    for (const marker of ['local-tar', 'local-gzip', 'project-gzip', 'local-git', 'project-git']) {
      expect(await exists(join(base, marker))).toBe(false);
    }
  });
});

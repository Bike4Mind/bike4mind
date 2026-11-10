import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** Whether the temp folder tells `a` from `A`; macOS and Windows fold case by default. */
const tmpKeepsCase = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'b4m-case-'));
  try {
    writeFileSync(join(probe, 'a'), '');
    return !existsSync(join(probe, 'A'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

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

const REPLACEMENT = String.fromCharCode(0xfffd);

/** Commands in a repository with a large node_modules: those that run as the mode allows, and those that ask. */
describe('shell approval in a project with a large node_modules', () => {
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
    // An untracked folder holding its own settings, which `git clean` removes whole.
    await mkdir(join(brepo, 'k', '.claude'), { recursive: true });
    await writeFile(join(brepo, 'k', '.claude', 'settings.json'), '{}');
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
    // hrepo's last commit, "second", changes its settings, and its work tree matches that commit.
    const hrepo = await repository('hrepo', { '.claude/settings.json': '{}', 'src/b.ts': 'b' });
    await writeFile(join(hrepo, '.claude', 'settings.json'), '{"x": 1}');
    git(hrepo, 'commit', '-qam', 'second');
    await mkdir(join(hrepo, ':'));
    for (const name of ['^^!', '^^-1', 'HEAD^!', 'HEAD^-+1', 'HEAD^- 1', ':/first', ':/fir*']) {
      await writeFile(join(hrepo, name), '');
    }
    // Files named as some words are written, which bash passes to git as other values.
    for (const name of ["HEAD''~1", 'HEAD\\~1', 'HEAD~1:.', 'HEAD~1:src']) await writeFile(join(hrepo, name), '');
    await mkdir(join(srepo, '\\--output=.claude'));
    for (const name of ['\\*', ':\\!src', ':\\(exclude\\)src', '\\--output=.claude/settings.json', '*', ':.claude']) {
      await writeFile(join(srepo, name), '');
    }
    // Names bash may pass git that git reads as magic or as a glob reaching `.claude/settings.json`.
    for (const name of [':!x.ts', '[.]claude[!z]settings.json', '[.]claude[.-0test]settings.json']) {
      await writeFile(join(srepo, name), '');
    }
    for (const name of ['q]x', '.x.']) await writeFile(join(srepo, 'src', name), '');
    // `*[<KELVIN SIGN>n]` matches `*k*` under nocaseglob, and git reads it as a glob matching `settings.json`.
    await writeFile(join(srepo, `*[${String.fromCharCode(0x212a)}n]`), '');
    // vrepo has settings changed below `w`, and a file named as `\--relative=w` is written.
    const vrepo = await repository('vrepo', { 'w/.claude/settings.json': '{}' });
    await writeFile(join(vrepo, 'w', '.claude', 'settings.json'), '{"x": 1}');
    await writeFile(join(vrepo, '\\--relative=w'), '');
    // nrepo is a Next.js layout with bracket route names, everything changed, and a planted name that git reads as
    // a glob matching `.claude/settings.json`.
    const routes = ['pages/[id].tsx', 'pages/index.tsx', 'app/[[...slug]]/page.tsx', 'app/home/page.tsx'];
    const nrepo = await repository('nrepo', {
      '.claude/settings.json': '{}',
      ...Object.fromEntries(routes.map(route => [route, 'a'])),
    });
    for (const path of ['.claude/settings.json', ...routes]) await writeFile(join(nrepo, path), 'b');
    await writeFile(join(nrepo, '[.]claude[!q]settings.jso[nq]'), '');
    await writeFile(join(nrepo, `[.]claude[!q]settings.jso[n${REPLACEMENT}]`), '');
    await writeFile(join(nrepo, 'a'.repeat(56)), '');
    // urepo is a clone two commits deep whose main tracks origin/main, with an untracked `u.ts` at its top.
    const orepo = await repository('orepo', { '.claude/settings.json': '{}', 'src/b.ts': 'b' });
    await writeFile(join(orepo, 'src', 'b.ts'), 'b2');
    git(orepo, 'commit', '-qam', 'second');
    git(proj, 'clone', '-q', orepo, join(proj, 'urepo'));
    await writeFile(join(proj, 'urepo', 'u.ts'), 'u');
    // wrepo has the same history, with `HEAD^!` its only top-level name a bare `*` expands to.
    const wrepo = await repository('wrepo', { '.claude/settings.json': '{}' });
    await writeFile(join(wrepo, '.claude', 'settings.json'), '{"x": 1}');
    git(wrepo, 'commit', '-qam', 'second');
    await writeFile(join(wrepo, 'HEAD^!'), '');
    // arepo gives settings an attribute, which the scan's git, reading attributes from the empty tree, never sees.
    const arepo = await repository('arepo', { '.gitattributes': '.claude/** foo\n', '.claude/settings.json': '{}' });
    await writeFile(join(arepo, '.claude', 'settings.json'), '{"x": 1}');
    // grepo has two commits, so `HEAD~1` names one.
    const grepo = await repository('grepo', { '.claude/settings.json': '{}', 'src/b.ts': 'b' });
    await writeFile(join(grepo, 'src', 'b.ts'), 'b2');
    git(grepo, 'commit', '-qam', 'second');
    // qrepo has untracked settings and aliases in its own config; zrepo has git run the command it guesses for a typo.
    const qrepo = await repository('qrepo', { 'src/b.ts': 'b' });
    await mkdir(join(qrepo, '.claude'));
    await writeFile(join(qrepo, '.claude', 'settings.json'), '{}');
    for (const [name, value] of [
      ['tidy', 'clean -fdx'],
      ['t2', 'tidy'],
      ['zap', '!rm -rf .claude'],
      ['st', 'status'],
      ['co', 'checkout'],
      ['lg', 'log --oneline --graph'],
      ['lq', "log --format='%h %s'"],
      ['p', 'push'],
      ['lo', 'log --output=.claude/settings.json'],
      ['up', "ls-remote --upload-pack='touch x'"],
      ['loop', 'loop2'],
      ['loop2', 'loop'],
      ['bare', ''],
      ['bang', '!touch x'],
      ['ci', 'commit'],
      ['tabbed', 'status\t--short'],
      // git runs its own show-branch over an alias, and an alias over pack-redundant, which it lists as deprecated.
      ['show-branch', 'clean -fdx'],
      ['pack-redundant', '!touch x'],
    ]) {
      git(qrepo, 'config', `alias.${name}`, value as string);
    }
    git(qrepo, 'config', 'help.autocorrect', '0');
    // Relative to .git/config, so proj/qinc.cfg, outside qrepo's work tree; it need not exist.
    git(qrepo, 'config', 'include.path', '../../qinc.cfg');
    // irepo includes a file in its own work tree, which a git command may rewrite.
    const irepo = await repository('irepo', { 'src/b.ts': 'b' });
    git(irepo, 'config', 'alias.st', 'status');
    git(irepo, 'config', 'include.path', '../inc.cfg');
    const zrepo = await repository('zrepo', { 'src/b.ts': 'b' });
    git(zrepo, 'config', 'help.autocorrect', '1');
    // trepo's index records `sub` as a submodule whose work tree holds settings.
    const trepo = await repository('trepo', { 'src/b.ts': 'b' });
    await mkdir(join(trepo, 'sub', '.claude'), { recursive: true });
    await writeFile(join(trepo, 'sub', '.claude', 'settings.json'), '{}');
    const head = execFileSync('git', ['-C', trepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    git(trepo, 'update-index', '--add', '--cacheinfo', `160000,${head},sub`);
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
    vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
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
  // The rules floor refuses any command naming `.claude`; auto and full run it.
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
    ["git diff --name-only -- ':!x.lock' | xargs sed -i s/a/b/", '', unasked],
    ["git diff --name-only ':!a' | xargs sed -i s/a/b/", '', unasked],
    ["git diff --name-only ':^a' | xargs wc -l", '', unasked],
    ["git diff --name-only -- . ':(exclude)src/c.ts' | xargs wc -l", '', unasked],
    ["git diff --name-only -- ':(glob)src/**' | xargs sed -i s/a/b/", '', unasked],
    ["git diff --name-only ':/src' | xargs sed -i s/a/b/", '', unasked],
    ["git diff --name-only -- ':(top,icase)SRC' | xargs sed -i s/a/b/", '', unasked],
    ["git diff --name-only '*.ts' | xargs sed -i s/a/b/", '', unasked],
    ["git diff --name-only 'src/[id].tsx' | xargs sed -i s/a/b/", '', unasked],
    ["git diff --name-only 'src/*.ts' ':!a' | xargs wc -l", '', unasked],
    ['git diff --name-only --relative | xargs sed -i s/a/b/', '', unasked],
    ['rg -l foo 2>"/dev/null" | xargs sed -i s/a/b/', '', unasked],
    ["rg -l foo 2>'/dev/null' | xargs cat", '', unasked],
    ['rg -l foo | grep -v zz 2>/dev/null | xargs sed -i s/a/b/', '', unasked],
    ['git ls-files | grep -v x 2>/dev/null | head -5 | xargs wc -l', '', unasked],
    ['git diff --name-only HEAD~1 | xargs sed -i s/a/b/', 'urepo', unasked],
    ['git diff --name-only @{u} | xargs sed -i s/a/b/', 'urepo', unasked],
    ['git diff --name-only main..HEAD | xargs sed -i s/a/b/', 'urepo', unasked],
    ['git diff --name-only origin/main...HEAD | xargs sed -i s/a/b/', 'urepo', unasked],
    ['git diff --name-only @{u} -- src | xargs sed -i s/a/b/', 'urepo', unasked],
    ['git diff --name-only origin/main...HEAD -- src | xargs sed -i s/a/b/', 'urepo', unasked],
    ['git diff --name-only -- src/*.ts | xargs npx prettier --check', '', unasked],
    ['git diff --name-only -- src/*.ts | xargs wc -l', '', unasked],
    ['git diff --name-only HEAD~1 -- src/*.ts | xargs sed -i s/a/b/', 'urepo', unasked],
    ['git diff --name-only -- *.ts | xargs sed -i s/a/b/', 'urepo', unasked],
    ['git diff --name-only -- src/{b,c}.ts | xargs sed -i s/a/b/', 'urepo', unasked],
    // With no match, bash passes each pattern as written.
    ['git diff --name-only -- *.ts | xargs eslint', '', unasked],
    ['git diff --name-only -- src/*.tsx | xargs eslint', '', unasked],
    ['git diff --name-only -- src/*.ts src/*.tsx | xargs eslint', '', unasked],
    ['git diff --name-only -- src/*.{ts,tsx} | xargs eslint', '', unasked],
    ['git diff --name-only -- *.{ts,tsx} | xargs eslint', '', unasked],
    ['git diff --name-only -- src/**/*.ts | xargs eslint', '', unasked],
    // bash passes the bracket names, which the scan's git reads as the command's does.
    ['git diff --name-only -- pages/*.tsx | xargs npx prettier --write', 'nrepo', unasked],
    ['git diff --name-only -- app/**/*.tsx | xargs npx eslint', 'nrepo', unasked],
    ['git diff --name-only -- app/*/page.tsx | xargs npx eslint --fix', 'nrepo', unasked],
    ['git diff --name-only HEAD -- pages/*.tsx | xargs sed -i s/a/b/', 'nrepo', unasked],
    ['cat .claude/agents/x.md', '', unaskedNamingClaude],
    ['ls -la .claude/', '', unaskedNamingClaude],
    ['grep -r hooks .claude', '', unaskedNamingClaude],
    ['git diff .claude/settings.json', '', unaskedNamingClaude],
    ['git log -- .claude', '', unaskedNamingClaude],
    ['git add .claude/commands/x.md', '', unaskedNamingClaude],
    ['cp a .claude/commands/y.md', '', unaskedNamingClaude],
    ['git stash', 'crepo', unasked],
    ['git reset --hard', 'crepo', unasked],
  ])('decides %s (in proj/%s) as the mode allows', async (command, folder, expected) => {
    expect(await judge(command, folder)).toEqual(expected);
  });

  // shellScan.globWalk.test.ts bounds how often the matcher searches a name.
  it('reads a glob of many stars against a long name', async () => {
    expect(await judge('git diff --name-only -- *a*a*a*a*a*a*a*a*b | xargs wc -l', 'nrepo')).toEqual(unasked);
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
    ["git diff --name-only -- ':(attr:foo)' | xargs sed -i s/a/b/", 'arepo'],
    ["git diff --name-only ':!src' | xargs sed -i s/a/b/", 'srepo'],
    ["git diff --name-only -- .claude ':!.claude/x' | xargs sed -i s/a/b/", 'srepo'],
    ["git diff --name-only -- ':(top).claude' | xargs sed -i s/a/b/", 'srepo'],
    ["git diff --name-only -- ':(icase).CLAUDE' | xargs sed -i s/a/b/", 'srepo'],
    ["git diff --name-only ':/.claude' | xargs sed -i s/a/b/", 'srepo'],
    ["git diff --name-only '.c*' | xargs sed -i s/a/b/", 'srepo'],
    ['git diff --name-only --relative | xargs sed -i s/a/b/', 'srepo'],
    // `:/sid*` names the commit whose message matches, so git compares it with the work tree.
    ["git diff --name-only ':/sid*' | xargs sed -i s/a/b/", 'mrepo'],
    // git diff reads each as revisions of the last commit, though rev-parse --verify exits 1 for the parent forms.
    ["git diff --name-only 'HEAD^{/.*}^!' | xargs sed -i s/a/b/", 'hrepo'],
    ["git diff --name-only 'HEAD^{/.*}^@' | xargs sed -i s/a/b/", 'hrepo'],
    ["git diff --name-only 'HEAD^{/.*}^-' | xargs sed -i s/a/b/", 'hrepo'],
    ["git diff --name-only 'HEAD^{/.*}^-1' | xargs sed -i s/a/b/", 'hrepo'],
    ["git diff --name-only ':/sec*^!' | xargs sed -i s/a/b/", 'hrepo'],
    ["git diff --name-only ':/sec*^@' | xargs sed -i s/a/b/", 'hrepo'],
    ["git diff --name-only ':/sec*^-' | xargs sed -i s/a/b/", 'hrepo'],
    ["git diff --name-only '^HEAD^{/fir*}' | xargs sed -i s/a/b/", 'hrepo'],
    // A file of the same name does not make git read a parent shorthand as a path.
    ["git diff --name-only ':/^^!' | xargs sed -i s/a/b/", 'hrepo'],
    ["git diff --name-only ':/^^-1' | xargs sed -i s/a/b/", 'hrepo'],
    ["git diff --name-only 'HEAD^!' | xargs sed -i s/a/b/", 'hrepo'],
    ["git diff --name-only 'HEAD^-+1' | xargs sed -i s/a/b/", 'hrepo'],
    ["git diff --name-only 'HEAD^- 1' | xargs sed -i s/a/b/", 'hrepo'],
    // Each names a commit by its message, though a file `:/first` and a file `:/fir*` exist.
    ["git diff --name-only ':/first' | xargs sed -i s/a/b/", 'hrepo'],
    ["git diff --name-only ':/fir*' | xargs sed -i s/a/b/", 'hrepo'],
    // bash expands `*` to `HEAD^!` before git reads it.
    ['git diff --name-only * | xargs sed -i s/a/b/', 'wrepo'],
    // bash passes each to git as its value, not as written.
    ['git diff --name-only -- :\\!src | xargs sed -i s/a/b/', 'srepo'],
    ['git diff --name-only -- :\\^src | xargs sed -i s/a/b/', 'srepo'],
    ['git diff --name-only -- :\\(exclude\\)src | xargs sed -i s/a/b/', 'srepo'],
    ['git diff --name-only :\\!src | xargs sed -i s/a/b/', 'srepo'],
    ['git diff --name-only :\\(exclude\\)src | xargs sed -i s/a/b/', 'srepo'],
    ['git diff --name-only -- \\* | xargs sed -i s/a/b/', 'srepo'],
    ["git diff --name-only -- ':!'src | xargs sed -i s/a/b/", 'srepo'],
    ['git diff --name-only -- ":(exclude)"src | xargs sed -i s/a/b/', 'srepo'],
    ['git diff --name-only -- * | xargs sed -i s/a/b/', 'srepo'],
    ['git diff --name-only \\* | xargs sed -i s/a/b/', 'srepo'],
    ['git diff --name-only \\--output=.claude/settings.json | xargs sed -i s/a/b/', 'srepo'],
    ["git diff --name-only HEAD''~1 | xargs sed -i s/a/b/", 'hrepo'],
    ['git diff --name-only HEAD\\~1 | xargs sed -i s/a/b/', 'hrepo'],
    // git reads each as a tree of HEAD~1, though a file `HEAD~1:.` and a file `HEAD~1:src` exist.
    ['git diff --name-only HEAD~1:./ | xargs sed -i s/a/b/', 'hrepo'],
    ['git diff --name-only HEAD~1:src/ | xargs sed -i s/a/b/', 'hrepo'],
    // git reads `--relative=w`, printing `w/.claude/settings.json` as `.claude/settings.json`.
    ['git diff --name-only \\--relative=w | xargs sed -i s/a/b/', 'vrepo'],
    // bash expands `*w` to the folder `w`, which git lists the settings below.
    ['git diff --name-only -- *w | xargs sed -i s/a/b/', 'vrepo'],
    // Globs after `--` the scan does not read: bash may make names git reads more widely (`*`, `:.claude`).
    ['git diff --name-only -- ? | xargs sed -i s/a/b/', 'srepo'],
    ['git diff --name-only -- :* | xargs sed -i s/a/b/', 'srepo'],
    ['git diff --name-only -- src/*\\]x | xargs sed -i s/a/b/', 'srepo'],
    ['git diff --name-only -- src/[ab].ts | xargs sed -i s/a/b/', 'srepo'],
    // bash passes a name git reads as an exclude-only pathspec or as a glob reaching the settings.
    ['git diff --name-only -- *.ts | xargs sed -i s/a/b/', 'srepo'],
    ['git diff --name-only -- *z* | xargs sed -i s/a/b/', 'srepo'],
    ['git diff --name-only -- *test* | xargs sed -i s/a/b/', 'srepo'],
    ['git diff --name-only -- *q* | xargs sed -i s/a/b/', 'nrepo'],
    // The shell gets a lone surrogate as U+FFFD, which the planted name holds.
    [`git diff --name-only -- *${REPLACEMENT}* | xargs sed -i s/a/b/`, 'nrepo'],
    [`git diff --name-only -- *${String.fromCharCode(0xd800)}* | xargs sed -i s/a/b/`, 'nrepo'],
    [`git diff --name-only -- *${String.fromCharCode(0xdc00)}* | xargs sed -i s/a/b/`, 'nrepo'],
    // A bash without globskipdots expands `src/.*.` to `src/..` too.
    ['git diff --name-only -- src/.*. | xargs sed -i s/a/b/', 'srepo'],
    // bash re-reads the `\` the range makes, passing git `.claude`.
    ['git diff --name-only -- .cl{a..Z..5}aude | xargs sed -i s/a/b/', 'srepo'],
    // bash 3.2 leaves a stepped sequence as written, so git gets a bracket class holding `.`.
    ["git diff --name-only -- '['{1..1..1}']c*/s*' | xargs sed -i s/a/b/", 'srepo'],
    // bash 3.2 drops the padding, passing git the wider `*0*`.
    ["git diff --name-only -- '*'{00..0}'*' | xargs sed -i s/a/b/", 'srepo'],
    ['git diff --name-only x{1..1} -- | xargs sed -i s/a/b/', 'srepo'],
    // bash pairs the `{` with the `}` after the comma, passing git `x}a` and `.c*/s*`.
    ['git diff --name-only -- {x}a,.c*}/s* | xargs sed -i s/a/b/', 'srepo'],
    ["git diff --name-only -- '*'{+1..1}'*' | xargs sed -i s/a/b/", 'srepo'],
    ['shopt -s nullglob; git diff --name-only -- src/*.ts | xargs sed -i s/a/b/', 'srepo'],
    // Under nullglob find gets no start point and walks `.`.
    ['shopt -s nullglob; find src/*.zz -delete', ''],
    ['shopt -s nullglob\nfind src/*.zz -name settings.json -delete', ''],
    ['rg -l hooks 2>"/dev/null" | xargs sed -i s/a/b/', ''],
    ['rg -l hooks | grep -v zz 2>/dev/null | xargs sed -i s/a/b/', ''],
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
    // bash pairs the `{` with the `}` after the comma, so each names `.claude`.
    'rm -rf {x}a,.cl{a,a}ude}',
    'cp a {x}a,.claude/settings.json}',
    // tar reads its first word as an old-style cluster whatever bash makes of the braces, and `T` names a file list.
    'tar cvfT{1..3..1} list',
  ])('asks in every mode for %s', async command => {
    expect(await judge(command)).toMatchObject(asks);
  });

  // bash 4 and later pass each as `.claude`, the last beside `x}a`; bash 3.2 keeps a step as written.
  const claudeBraceWords = [
    '.clau{d..d..1}e',
    '.claud{e..e..2}',
    '.cl{a..a..1}ude',
    '.clau{d..d..-1}e',
    '{x}a,.claude}',
  ];

  it.each(claudeBraceWords)('reads %s as a word host bash 4 or later passes as .claude', word => {
    const [major, ...printed] = execFileSync('bash', ['-c', `printf '%s\\n' "\${BASH_VERSINFO[0]}" ${word}`], {
      encoding: 'utf8',
    }).split('\n');
    if (Number(major) >= 4) expect(printed).toContain('.claude');
  });

  it.each(
    claudeBraceWords.flatMap(word =>
      [
        'git checkout --',
        'git restore',
        'git rm -r',
        'git rm -rf --cached',
        'git clean -fdx',
        'git add',
        'git reset --',
        'npx prettier --write',
      ].map(command => `${command} ${word}`)
    )
  )('asks in every mode for %s, whose braces the scan leaves unread', async command => {
    expect(await judge(command)).toMatchObject(asks);
  });

  it.each(
    [
      ['a step', '.clau{d..d..1}e', '.clau{d..d..1}e/settings.json'],
      ['a signed step', '.clau{d..d..-1}e', '.clau{d..d..-1}e/settings.json'],
      ['a signed bound', '.claude{+1..1}', '.claude/x{+1..1}'],
      ['zero padding', '.claude{01..1}', '.claude/x{01..1}'],
      ['a bound past 32 bits', '.claude{2147483648..2147483648}', '.claude/x{2147483648..2147483648}'],
      ['a `..` that makes no sequence', '.clau{d..dd}e', '.clau{d..dd}e/settings.json'],
      ['unbalanced braces around a comma', '{x}a,.claude}', '{x}a,.claude}/settings.json'],
      ['unbalanced braces around a `..`', '.clau{d..d}e}', '.clau{d..d}e}/settings.json'],
    ].flatMap(([form, bare, slashed]) =>
      [
        'git checkout --',
        'git restore',
        'git rm -r',
        'git clean -fdx',
        'git add',
        'git reset --',
        'npx prettier --write',
        'npx eslint --fix',
        'rm -rf',
        'mv src/a.ts',
        'cp src/a.ts',
      ].flatMap(command => [
        [`${command} ${bare}`, form],
        [`${command} ${slashed}`, form],
      ])
    )
  )('asks in every mode for %s, a word with %s', async command => {
    expect(await judge(command)).toMatchObject(asks);
  });

  it.each(
    ['grep -R a', 'ls -L', 'ln -s src/a.ts', 'tar -xf clean.tar -C', 'cp -rL src'].map(
      command => `${command} .clau{d..d..1}e`
    )
  )('asks in every mode for %s, whose walked, linked or unpacked tree the scan leaves unread', async command => {
    expect(await judge(command)).toMatchObject(asks);
  });

  it.each([
    // Brace expansion ends the outer double quote at the inner `"`, so bash runs `rm -rf "x"` and `rm -rf ".claude"`.
    'echo "`rm -rf "{x,.claude}"`"',
    'echo "`rm -rf ".clau{d..d}e"`"',
    // bash 3.2 does the same for a `$(` within double quotes.
    'echo "$(rm -rf "{x,.claude}")"',
    'npx prettier --write "${x:-"{x,.claude}"}"',
    'for f in "`rm -rf "{x,.claude}"`"; do :; done',
    'a=("`rm -rf "{x,.claude}"`")',
    'export x="`rm -rf "{x,.claude}"`"',
    'cat < "`rm -rf "{x,.claude}"`"',
    // `[` and `unset` are builtins, whose words bash brace-expands as it does any command's.
    '[ "`rm -rf "{x,.claude}"`" ]',
    'if [ "`rm -rf "{x,.claude}"`" ]; then :; fi',
    'while [ "`rm -rf "{x,.claude}"`" ]; do :; done',
    '! [ "`rm -rf "{x,.claude}"`" ]',
    '{ [ "`rm -rf "{x,.claude}"`" ]; }',
    '[ -n x -a "`rm -rf "{x,.claude}"`" = y ]',
    '[ "$(rm -rf "{x,.claude}")" ]',
    'unset "`rm -rf "{x,.claude}"`"',
    '[ "`cat "{x,../.config/Bike4Mind/value}"`" ]',
    'f() { local x="`rm -rf "{x,.claude}"`"; }; f',
    'rm -rf "${x:-$"{x,.claude}"}"',
    'rm -rf {x,\\\n.claude}',
    'echo $(( `rm -rf "{x,.claude}"` 1 ))',
  ])('asks in every mode for %s, reading its braces by bash quote rules', async command => {
    expect(await judge(command)).toMatchObject(asks);
  });

  it.each([
    // bash brace-expands no here-string, `case` word, `[[` test, assignment, comment or `$"..."` string.
    'cat <<< "`rm -rf "{x,.claude}"`"',
    'case "`rm -rf "{x,.claude}"`" in *) ;; esac',
    '[[ "`rm -rf "{x,.claude}"`" ]]',
    'x="`rm -rf "{x,.claude}"`"',
    'rm -rf x #{x,.claude}',
    'rm -rf $"{x,.claude}"',
  ])('runs %s unasked, as bash passes its braces as written', async command => {
    expect(await judge(command)).toMatchObject({ auto: true, full: true });
  });

  it.each([
    // bash expands the braces first, so each reads the empty `$PWD_` or `$HOME_` and names the path after it.
    'cd src && cat $PWD{_,_}../../.config/Bike4Mind/value',
    'cd src && cat {$PWD,x}_../../.config/Bike4Mind/value',
    'rm -rf $PWD{_,_}.claude',
    'rm -rf $HOME{_,_}.claude',
    'npx prettier --write $PWD{_,_}.claude/settings.json',
    'rm -rf $${a,b}',
  ])('asks in every mode for %s, whose `$name` bash reads on into its braces', async command => {
    expect(await judge(command)).toMatchObject(asks);
  });

  it.each([
    ['git clean -fdx $x', ''],
    ['git clean -fdx ${x:+}.claude', ''],
    ['git clean -fdx -- "$x"', ''],
    ['git clean -fdx `echo .claude`', ''],
    ['git clean -fdX -e $x', ''],
    ['git clean -fdX --exclude=$x', ''],
    ['git rm -r $x', ''],
    ['git rm -r ${x:+}.claude', ''],
    ['git rm -r --cached $x', ''],
    ['git mv $x y', ''],
    ['git mv -f src/a.ts $x', ''],
    // brepo's `.claude` is untracked, so each exclude pattern makes it one more ignored folder `-X` removes.
    ["git clean -fdX -e '.clau*'", 'brepo'],
    ["git clean -fdX -e '.clau*' -e a", 'brepo'],
    ["git clean -fdX -e a --exclude '.clau*' -e b", 'brepo'],
    ["git clean -fdX -e'.clau*'", 'brepo'],
    ["git clean -fdX -e.cl''au*", 'brepo'],
    ['git clean -fdx', 'brepo'],
    // A second `-f` removes the nested repositories too, each holding its own settings.
    ['git clean -ffdx', ''],
    ['git clean -f -f -dx', ''],
    ['git clean -fdx --force', ''],
    ['git clean -fd k', 'brepo'],
    ['git clean -fdx k', 'brepo'],
  ])('asks in every mode for %s (in proj/%s), whose paths git removes or moves', async (command, folder) => {
    expect(await judge(command, folder)).toMatchObject(asks);
  });

  it.each(['\u00fcdir', ...(process.platform === 'win32' ? [] : ['line\ndir', 'back\\slash', '"quote'])])(
    'asks when git quotes a removed folder named %j holding settings',
    async name => {
      const repository = join(proj, 'quoted-repo');
      await mkdir(join(repository, name, '.claude'), { recursive: true });
      try {
        execFileSync('git', ['-C', repository, 'init', '-q']);
        execFileSync('git', ['-C', repository, 'config', 'core.quotePath', 'true']);
        await writeFile(join(repository, name, '.claude', 'settings.json'), '{}');
        expect(execFileSync('git', ['-C', repository, 'clean', '-nfdx'], { encoding: 'utf8' })).toMatch(
          /^Would remove "/
        );

        expect(await judge('git clean -fdx', 'quoted-repo')).toMatchObject(asks);
      } finally {
        await rm(repository, { recursive: true, force: true });
      }
    }
  );

  it.each([
    "git cle''an -fdx",
    'git cle"an" -fdx',
    'git c\\lean -fdx',
    'git cl$x -fdx',
    'git c{l,}ean -fdx',
    'git cle?n -fdx',
    "git -C . cle''an -fdx",
    "env git cle''an -fdx",
    "git pu''sh origin main",
    'git cle[a]n -fdx',
    'git cle\\an -fdx',
    "git sta''tus",
    'git "log"',
    'git lo$x',
    'git l{o,}g',
    'git sta?us',
    "git -c core.pager=cat cle''an -fdx",
    "git --no-pager cle''an -fdx",
    "git -C . -c a=b cle''an -fdx",
    "git --git-dir=.git cle''an -fdx",
    "command git cle''an -fdx",
    "command -- git cle''an -fdx",
    "nohup git cle''an -fdx",
    "time git cle''an -fdx",
    "sudo git cle''an -fdx",
    "xargs git cle''an -fdx",
    "echo | xargs git pu''sh",
    "(git cle''an -fdx)",
    "{ git cle''an -fdx; }",
    "true && git cle''an -fdx",
    "git status && git cle''an -fdx",
    "git ''clean -fdx",
    "git --no-pager ''status",
    'git --shallow-file x "log"',
    'git --shallow-file x "push" https://example.invalid/r main',
    'git --attr-source x "log"',
    'git -C . --super-prefix x "log"',
  ])('asks in every mode for %s, whose git subcommand bash rewrites', async command => {
    expect(await judge(command)).toMatchObject(asks);
  });

  const VALUED_GIT_OPTIONS = [
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--config-env',
    '--attr-source',
    '--super-prefix',
    '--shallow-file',
  ];

  it.each([
    ...VALUED_GIT_OPTIONS.flatMap(option => [
      `git ${option} main clean -fdx`,
      `git ${option} HEAD clean -fdx`,
      `git ${option}=main clean -fdx`,
      `git -C . ${option} main clean -fdx`,
      `git -c core.x=y ${option} main clean -fdx`,
      `git ${option} main -C . clean -fdx`,
    ]),
    'git -C . clean -fdx',
    'git -c core.x=y clean -fdx',
    'git --no-pager --attr-source main clean -fdx',
    'git --exec-path clean -fdx',
    'git --exec-path=x clean -fdx',
    'git --list-cmds=main clean -fdx',
    'git --bare clean -fdx',
    'git --future-option main clean -fdx',
    'git --no-pager HEAD clean -fdx',
    'git --no-pager ./x clean -fdx',
  ])('asks in every mode for %s, which git reads past its global options', async command => {
    expect(await judge(command, 'brepo')).toMatchObject(asks);
  });

  const SENDING_GIT = [
    'push https://example.invalid/r main',
    'remote add o https://example.invalid/r',
    'remote set-url o https://example.invalid/r',
    'send-email x',
  ];

  it.each([
    ...['-C', '-c', ...VALUED_GIT_OPTIONS].flatMap(option => SENDING_GIT.map(sending => `git ${option} x ${sending}`)),
    ...VALUED_GIT_OPTIONS.flatMap(option => SENDING_GIT.map(sending => `git ${option}=x ${sending}`)),
    ...VALUED_GIT_OPTIONS.flatMap(option => SENDING_GIT.map(sending => `git -C . ${option} x ${sending}`)),
    ...SENDING_GIT.map(sending => `git ${sending}`),
  ])('asks in auto mode for %s, which sends data out', async command => {
    expect((await judge(command)).auto).toBe(false);
  });

  it.each([
    'git -c man.man.path=./x.sh --help clean',
    'git -c man.man.path=./x.sh -h clean',
    'git -c man.man.path=./x.sh help clean',
    'git -c man.man.cmd=./x.sh --help clean',
    'git -c man.x.cmd= --help clean',
    'git -c core.pager= status',
    'git -c help.format=web -c help.browser=firefox -c browser.firefox.path=./x.sh -c help.htmlPath=./docs --help clean',
    'git -c help.format=web -c help.browser=firefox -c browser.firefox.path=./x.sh -c help.htmlPath=./docs help clean',
    'git -c browser.firefox.cmd=./x.sh help clean',
    'git -c difftool.x.path=./x.sh difftool',
    'git -c mergetool.x.path=./x.sh mergetool',
    'git --exec-path=./bin -c help.format=web -c help.htmlPath=./docs --help clean',
    'git --exec-path=./bin mergetool',
    'git --exec-path=./bin status',
    'git --exec-path=./bin --help clean',
    'git --exec-path=./bin --version',
    'git -C . --exec-path=./bin log',
    'GIT_EXEC_PATH=./bin git mergetool',
    'GIT_EXEC_PATH=./bin git --help clean',
    'GIT_EXEC_PATH=./bin git -h clean',
    'GIT_EXEC_PATH=./bin git help clean',
    'GIT_EXEC_PATH=./bin git -c help.format=web help clean',
    'export GIT_EXEC_PATH=./bin; git help clean',
    'env GIT_EXEC_PATH=./bin git mergetool',
    'export GIT_EXEC_PATH=./bin; git mergetool',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=man.man.path GIT_CONFIG_VALUE_0=./x.sh git help clean',
    'env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=./x.sh git log',
    `GIT_CONFIG_PARAMETERS="'man.man.path=./x.sh'" git help clean`,
    `env GIT_CONFIG_PARAMETERS="'core.pager=./x.sh'" git log`,
    'GIT_EDITOR=./x.sh git status',
    'GIT_PAGER=./x.sh git log',
    'GIT_TRACE=$PWD/.claude/settings.json git status',
    'env GIT_TRACE2_EVENT=/tmp/t git status',
    'GIT_TRACE2_EVENT=af_unix:./s git status',
    'GIT_PAGER+=x git log',
    'export GIT_PAGER; git log',
    'declare -x GIT_PAGER=./x.sh; git log',
    'typeset GIT_PAGER=./x.sh; git log',
    'local GIT_PAGER=./x.sh; git log',
    'readonly GIT_PAGER=./x.sh; git log',
    'read -r GIT_PAGER <<< ./x.sh; git log',
    'readarray GIT_PAGER <<< ./x.sh; git log',
    'mapfile GIT_PAGER < f; git log',
    'printf -v GIT_PAGER %s ./x.sh; git log',
    'getopts a GIT_PAGER; git log',
    'for GIT_PAGER in ./x.sh; do git log; done',
    'select GIT_PAGER in ./x.sh; do git log; done',
    'let GIT_PAGER=1; git log',
    ': ${GIT_PAGER:=./x.sh}; git log',
    ': ${GIT_PAGER=./x.sh}; git log',
    'true && export GIT_PAGER=./x.sh && git log',
    'v=PAGER; export GIT_$v=./x.sh; git log',
    'v=GIT_PAGER; export $v=./x.sh; git log',
    'v=GIT_PAGER; printf -v "$v" %s ./x.sh; git log',
    'env GIT_{PAGER,X}=./x.sh git log',
    "env $'GIT_PAGER'=./x.sh git log",
    'env $(cat f) git log',
  ])('asks in every mode for %s, which has git run a program the command names', async command => {
    expect(await judge(command)).toMatchObject(asks);
  });

  it.each([
    'git log --grep=GIT_PAGER',
    'git grep GIT_CONFIG_GLOBAL',
    'git log -S GIT_EDITOR --oneline',
    "git commit -m 'docs: explain GIT_SSH_COMMAND'",
    'echo GIT_PAGER && git status',
    'git status # GIT_PAGER',
    'rg GIT_SSH src && git diff',
    'git log --oneline | grep GIT_EXEC_PATH',
    'git diff -- docs/GIT_EDITOR.md',
    'git log --grep=GIT_TRACE',
  ])('runs %s unasked, as it only names a variable', async command => {
    expect(await judge(command)).toMatchObject({ auto: true, full: true });
  });

  it.each([
    'echo `GIT_EDITOR=./x.sh git commit --allow-empty`',
    'echo $(GIT_EDITOR=./x.sh git commit --allow-empty)',
    'cat <(GIT_EDITOR=./x.sh git commit --allow-empty)',
    '(export GIT_EDITOR=./x.sh; git commit --allow-empty)',
    'set -a; IFS= read -r GIT_EDITOR <<< ./x.sh; git commit --allow-empty',
    'set -a; while IFS= read -r GIT_EDITOR; do git commit --allow-empty; done <<< ./x.sh',
    'set -a; if IFS= read -r GIT_EDITOR <<< ./x.sh; then git commit --allow-empty; fi',
    'set -a; until IFS= read -r GIT_EDITOR <<< ./x.sh; do :; done; git commit --allow-empty',
    'set -a; ! IFS= read -r GIT_EDITOR <<< ./x.sh; git commit --allow-empty',
    'set -a; time IFS= read -r GIT_EDITOR <<< ./x.sh; git commit --allow-empty',
    'set -o allexport; IFS= read -r GIT_EDITOR <<< ./x.sh; git commit --allow-empty',
    'set -a; builtin printf -v GIT_EDITOR %s ./x.sh; git commit --allow-empty',
    'set -a; command printf -v GIT_EDITOR %s ./x.sh; git commit --allow-empty',
    'set -a; LC_ALL=C printf -v GIT_EDITOR %s ./x.sh; git commit --allow-empty',
    'set -a; printf -vGIT_EDITOR %s ./x.sh; git commit --allow-empty',
    'x=1 export GIT_EDITOR; git commit --allow-empty',
    'x=1 export GIT_EDITOR=./x.sh; git commit --allow-empty',
    'time export GIT_EDITOR=./x.sh; git commit --allow-empty',
    '! export GIT_EDITOR=./x.sh; git commit --allow-empty',
    'if export GIT_EDITOR=./x.sh; then git commit --allow-empty; fi',
    'command -p export GIT_EDITOR=./x.sh; git commit --allow-empty',
    'builtin export GIT_EDITOR=./x.sh; git commit --allow-empty',
    "export 'a=|' GIT_EDITOR; git commit --allow-empty",
    "declare -x 'a=;' GIT_EDITOR; git commit --allow-empty",
    'x=1 declare -n r=GIT_EDITOR; r=./x.sh; export r; git commit --allow-empty',
    'set -a; IFS= read -r GIT_CONFIG_GLOBAL <<< ./evil.cfg; git status',
    'set -a; IFS= read -r GIT_TRACE <<< "$PWD/.claude/settings.json"; git status',
    'v=GIT_EDITOR; x=1 export $v=./x.sh; git commit --allow-empty',
    'v=GIT_EDITOR; set -a; read -r $v <<< ./x.sh; git commit --allow-empty',
    'v=GIT_EDITOR; declare -n r=$v; r=./x.sh; export r; git commit --allow-empty',
    'v=GIT_EDITOR; command -p export "$v=./x.sh"; git commit --allow-empty',
    "env -S'GIT_EDITOR=./x.sh git' commit --allow-empty",
    "env -S 'GIT_EDITOR=./x.sh git' commit --allow-empty",
    "env --split-string='GIT_EDITOR=./x.sh git' commit --allow-empty",
    'EDITOR=./x.sh git commit --allow-empty',
    'export VISUAL=./x.sh; git commit --allow-empty',
    'PAGER=./x.sh git log',
    'GIT_EDITOR[0]=./x.sh git commit --allow-empty',
    'GIT_INDEX_FILE=.claude/settings.json git add -A',
    'export GIT_OBJECT_DIRECTORY=.claude; git add -A',
    'time for i in 1; do git -c core.fsmonitor=./x.sh status; done',
    '! for i in 1; do git -c core.fsmonitor=./x.sh status; done',
    'time while true; do git -c core.fsmonitor=./x.sh status; break; done',
    'time { git -c core.fsmonitor=./x.sh status; }',
    "export 'GIT_EDITOR'=./x.sh; git commit --allow-empty",
    'export "GIT_EDITOR"=./x.sh; git commit --allow-empty',
    'export GIT_EDI\\TOR=./x.sh; git commit --allow-empty',
    "declare -x GIT_E''DITOR=./x.sh; git commit --allow-empty",
    "set -a; printf -v GIT_E''DITOR %s ./x.sh; git commit --allow-empty",
    "set -a; printf -vGIT_E''DITOR %s ./x.sh; git commit --allow-empty",
    'set -a; read -r GIT_EDITOR[0] <<< ./x.sh; git commit --allow-empty',
    'GIT_TRACE=""/tmp/t git status',
    "GIT_TRACE=''/tmp/t git status",
    'SSH_ASKPASS=./x.sh git fetch',
    'GIT_DIFFTOOL_EXTCMD=./x.sh git difftool HEAD~1',
    'GIT_DIFF_TOOL=../../x git difftool HEAD~1',
    'GIT_MERGE_TOOL=../x git mergetool',
    'GIT_MERGE_TOOL=$T git mergetool',
    "GIT_EDITOR=./x.sh bash -c 'git commit --allow-empty'",
    "GIT_EDITOR=./x.sh sh -c 'git commit --allow-empty'",
    "export GIT_EXEC_PATH=./bin; bash -c 'git help clean'",
    "export GIT_EXEC_PATH=./bin; sh -ec 'git help clean'",
    "export GIT_PAGER=./x.sh; eval 'git log'",
    'GIT_PAGER=less git log',
    'GIT_EDITOR=vi git commit --allow-empty',
  ])('asks in every mode for %s, which sets a variable git runs a program from', async command => {
    expect(await judge(command)).toMatchObject(asks);
  });

  it.each([
    'GIT_PAGER=cat git log -1',
    'PAGER=cat git log -1',
    'GIT_PAGER= git log -1',
    'export GIT_PAGER=cat; git diff',
    'GIT_EDITOR=true git commit --amend',
    'EDITOR=true git commit --amend',
    'GIT_EDITOR=: git commit --amend',
    'GIT_DIFF_TOOL=vimdiff git diff',
    "git commit -m 'docs: let users run `pnpm dev`'",
    "git commit -m 'fix: read `args[0]` safely'",
    "echo 'see `a[0]`' > notes.md",
    'git --no-pager log -1',
    'GIT_TERMINAL_PROMPT=0 git fetch',
    'git config --get user.email',
    'cd src && git status',
  ])('runs %s unasked, as git runs no program it is handed', async command => {
    expect(await judge(command)).toMatchObject({ auto: true, full: true });
  });

  it('asks in every mode for a -c key that names a program, whatever its value', async () => {
    expect(await judge('git -c core.pager=cat log -1')).toMatchObject(asks);
  });

  it('asks in every mode for a rebase continued with an editor that runs nothing', async () => {
    expect(await judge('GIT_EDITOR=true git rebase --continue')).toMatchObject(asks);
  });

  it.each([
    'git log --grep=GIT_PAGER',
    'git grep GIT_CONFIG_GLOBAL',
    "git log -S 'GIT_EDITOR=' --oneline",
    "rg 'GIT_SSH_COMMAND=' && git diff",
    "git commit -m 'docs: set GIT_PAGER=less'",
    "git commit -m 'fix; export GIT_PAGER'",
    'echo GIT_PAGER && git status',
    'git status # GIT_PAGER',
    'GIT_TRACE=1 git status',
    'GIT_TRACE2_EVENT=t.json git status',
    "git log --grep 'GIT_TRACE2_EVENT=' --oneline",
    'export X=1; git log --grep=GIT_PAGER',
    'time git status',
    'for i in 1; do git status; done',
  ])('runs %s unasked, as it sets no variable git runs a program from', async command => {
    expect(await judge(command)).toMatchObject({ auto: true, full: true });
  });

  it.each([
    'git rm -r .',
    "git rm -r '*'",
    "git rm -r ':/'",
    "git rm -r '.clau*'",
    'git rm -r .clau*',
    'git rm -r .claude',
    'git rm .claude/settings.json',
    'git rm -r -- .claude',
    'cd src && git rm -r :/',
    'git mv .claude y',
    'git mv .clau* y',
    'git mv .claude/settings.json x.json',
    'git mv -f a .claude/settings.json',
    'git mv a .claude',
    'git mv a .clau*',
    'git mv -k a src .claude',
  ])('asks in every mode for %s, which removes, moves or replaces a settings file', async command => {
    expect(await judge(command)).toMatchObject(asks);
  });

  it.each([
    'git rm --cached -r .',
    'git rm -n -r .',
    'git rm src/a.ts',
    'git rm -r src',
    'git rm -r -- src',
    "git rm 'src/*.ts'",
    'git mv src/a.ts src/b.ts',
    'git mv -n src y',
    'git mv a src',
    'git mv a b',
  ])('runs %s unasked, as it removes or moves no settings file', async command => {
    expect(await judge(command)).toMatchObject({ auto: true, full: true });
  });

  it.each([
    ['git rm -r w', 'vrepo'],
    ['git mv w y', 'vrepo'],
    ['git mv -k w src y', 'vrepo'],
    ['git rm sub', 'trepo'],
    ['git rm --ignore-unmatch sub', 'trepo'],
  ])(
    'asks in every mode for %s (in proj/%s), which removes or moves a folder holding a settings file',
    async (command, folder) => {
      expect(await judge(command, folder)).toMatchObject(asks);
    }
  );

  it.each([
    "let 'a[$(touch x)]'",
    "let 'x = a[$(touch x)]'",
    "declare -i n='a[$(touch x)]'",
    "declare -i n; n='a[$(touch x)]'",
    "local -ri n='a[$(touch x)]'",
    "[[ 'a[$(touch x)]' -eq 1 ]]",
    '[[ 1 -lt a[\\$(touch x)] ]]',
    "(( 'a[$(touch x)]' ))",
    "a['$(touch x)']=1",
    'let n=a[\\`touch\\ x\\`]',
    'declare -i n=a[\\`touch\\ x\\`]',
  ])('asks in every mode for %s, where bash runs a quoted command in an arithmetic subscript', async command => {
    expect(await judge(command)).toMatchObject(asks);
  });

  it.each([
    'rm -rf ./{$x,y}a.claude',
    'rm -rf {$x,y}a.claude',
    'cat ./{$PWD,y}_../protected/value',
    'for f in ./{$x,y}a.claude; do rm -rf "$f"; done',
  ])('asks in every mode for %s, a word bash reads whole across a `{$`', async command => {
    expect(await judge(command)).toMatchObject(asks);
  });

  it.each(['echo a$ b', 'echo {$x} > /dev/null', 'echo "a$"', 'echo $x$y'])(
    'runs %s unasked, as each word reads as bash reads it',
    async command => {
      expect(await judge(command)).toMatchObject({ auto: true, full: true });
    }
  );

  it.each([
    'let i=1+2',
    'declare -i n=3',
    '[[ $(git rev-list --count HEAD) -gt 0 ]] && git status',
    "git log --format='%h $(x)'",
    'for ((i = 0; i < 2; i++)); do echo $i; done',
  ])('runs %s unasked, as no quoted command reaches arithmetic', async command => {
    expect(await judge(command)).toMatchObject({ auto: true, full: true });
  });

  const lowercased = [
    'export git_pager=./x.sh; git log',
    'Git_Exec_Path=./bin git status',
    'env git_editor=./x.sh git log',
  ];

  it.each(lowercased)('asks in every mode for %s on Windows, which reads variable names in any case', async command => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(await judge(command)).toMatchObject(asks);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it.runIf(process.platform !== 'win32').each(lowercased)(
    'runs %s unasked where variable names keep their case, as git reads no variable it sets',
    async command => {
      expect(await judge(command)).toMatchObject({ auto: true, full: true });
    }
  );

  it.each([
    "git ls-remote --upload-pack='rm -rf .claude k; git-upload-pack' .",
    "git ls-remote --upload-pack 'touch x; git-upload-pack' .",
    "git ls-remote --upl='touch x; git-upload-pack' .",
    "git ls-remote -u 'touch x; git-upload-pack' .",
    "git ls-remote -u'touch x' .",
    'git ls-remote --upload-pack="$X" .',
    "git fetch --upload-pack='touch x; git-upload-pack' .",
    'git fetch --upload-pack "touch x; git-upload-pack" .',
    "git pull --upload-pack='touch x; git-upload-pack' . main",
    "git fetch-pack --upload-pack='touch x' . main",
    "git fetch-pack --exec='touch x' . main",
    "git clone -u 'touch x; git-upload-pack' . y",
    "git clone --upload-pack='touch x' . y",
    "git archive --remote=. --exec='touch x; git-upload-archive' HEAD",
    "git archive --remote=. --exec 'touch x' HEAD",
    "git push --receive-pack='touch x; git-receive-pack' . HEAD:refs/heads/x",
    "git push --exec='touch x' . HEAD:refs/heads/x",
    "git push --ex='touch x' . HEAD:refs/heads/x",
    "git send-pack --receive-pack='touch x' . main",
    "git send-pack --exec='touch x' . main",
    "git -c protocol.ext.allow=always ls-remote 'ext::sh -c touch% x'",
    "git -c protocol.allow=always ls-remote 'ext::sh -c touch% x'",
    "GIT_ALLOW_PROTOCOL=ext git ls-remote 'ext::sh -c touch% x'",
    "GIT_ALLOW_PROTOCOL=ext git fetch 'ext::sh -c touch% x' main",
    "git -c protocol.ext.allow=always fetch 'ext::sh -c touch% x' main",
    'export GIT_ALLOW_PROTOCOL=ext; git fetch o',
    'git -c protocol.allow=always fetch o',
    'git ls-remote ext::sh',
    "git remote add o 'ext::sh -c touch% x'",
    'git -c remote.o.url=ext::sh fetch o',
    "git -c gpg.format=ssh -c gpg.ssh.defaultKeyCommand='rm -rf .claude k' commit -S --allow-empty -m m",
    'git -c gpg.ssh.defaultkeycommand=./x.sh commit -S -m m',
    'git -c sendemail.toCmd=./x.sh send-email x.patch',
    'git -c hook.x.command=./x.sh commit -m m',
    'git -c help.autocorrect=immediate cleen -fdx',
    "git -c submodule.x.update='!touch x' submodule update",
    "git -c interactive.diffFilter='touch x' add -p",
    'git -c imap.tunnel=./x.sh imap-send',
    "git grep -O'touch x' a",
    "git grep -nO'touch x' a",
    "git grep --open-files-in-pager='touch x' a",
    "git grep --open='touch x' a",
    "git difftool -y -x 'touch x' HEAD~1",
    "git difftool --extcmd='touch x' HEAD~1",
    "git rebase -x 'touch x' HEAD~1",
    "git rebase --exec='touch x' HEAD~1",
    "git filter-branch --tree-filter 'touch x' HEAD",
    "git instaweb --httpd='touch x'",
    "git send-email --sendmail-cmd='touch x' x.patch",
    "git send-email --to-cmd='touch x' x.patch",
    "git send-email -to-cmd='touch x' x.patch",
    'git send-email --smtp-server=./x.sh x.patch',
    "git remote-ext x 'sh -c touch% x'",
    'git daemon --access-hook=./x.sh',
    'git -c gc.recentObjectsHook=./x.sh gc',
    'git difftool -t ../../x HEAD~1',
    'git difftool --tool=../../x HEAD~1',
    'git difftool -yt../../x HEAD~1',
    'git difftool -t "$T" HEAD~1',
    'git mergetool -t ../x',
    'git mergetool --tool ../x',
    'git mergetool --tool=..\\\\x',
    'git -c diff.tool=../../x difftool HEAD~1',
    'git -c merge.tool=../x mergetool',
    'git -c merge.guitool=../x mergetool -g',
  ])('asks in every mode for %s, which has git run a command line its words give', async command => {
    expect(await judge(command)).toMatchObject(asks);
  });

  it.each([
    'git fetch origin',
    'git fetch --prune origin',
    'git fetch -u origin',
    'git ls-remote origin',
    'git ls-remote --tags origin',
    'git archive HEAD',
    'git archive --format=tar HEAD',
    'git grep -n a',
    'git grep -A3 -e a',
    'git grep -eO a',
    'git log --oneline -5',
    'git status',
    'git diff',
    'git commit -m x',
    'git -c gpg.format=ssh log -1',
    'git -c diff.tool=meld log -1',
    'git difftool --tool-help',
  ])('runs %s unasked, as git runs no command line its words give', async command => {
    expect(await judge(command)).toMatchObject({ auto: true, full: true });
  });

  it.each(['git push origin main', 'git push', 'git send-email --to=a@example.invalid x.patch'])(
    'runs %s in full mode, as it names no command for git to run',
    async command => {
      expect(await judge(command)).toMatchObject({ full: true });
    }
  );

  it.each([
    ['git tidy', 'qrepo'],
    ['git t2', 'qrepo'],
    ['git -C . tidy', 'qrepo'],
    ['git -C qrepo tidy', ''],
    ['git zap', 'qrepo'],
    ['git lo -1', 'qrepo'],
    ['git up .', 'qrepo'],
    ['git loop', 'qrepo'],
    ['git bare', 'qrepo'],
    ["git config alias.fresh 'clean -fdx' && git fresh", 'qrepo'],
    ["git config alias.st 'clean -fdx' && git st", 'qrepo'],
    ["git config --global alias.st 'clean -fdx'; git st", 'qrepo'],
    ['echo x >> .git/config; git st', 'qrepo'],
    ["for i in 1 2; do git st; git config alias.st 'clean -fdx'; done", 'qrepo'],
    ['git st & git config alias.st x', 'qrepo'],
    ['XDG_CONFIG_HOME=./x git st', 'qrepo'],
    ['HOME=./h git st', 'qrepo'],
    ['GIT_DIR=.git git st', 'qrepo'],
    ['git --git-dir=.git st', 'qrepo'],
    ['git -c core.x=y st', 'qrepo'],
    ['git cleen -fdx', 'zrepo'],
    ['git -c help.autocorrect=1 cleen -fdx', 'qrepo'],
    ['git bang', 'qrepo'],
    ['git TIDY', 'qrepo'],
    ['git st > .git/config', 'qrepo'],
    ['git st | tee .git/config', 'qrepo'],
    ['tee -a .git/config < /dev/null | git st', 'qrepo'],
    ['sed -i s/a/b/ .git/config && git st', 'qrepo'],
    ['cp x.cfg .git/config; git st', 'qrepo'],
    ['rm -rf .git && git st', 'qrepo'],
    ['git branch -u origin/main && git st', 'qrepo'],
    ['git worktree add ../w && git st', 'qrepo'],
    ['git worktree add w && git st', 'qrepo'],
    ['coproc git config alias.st x; git st', 'qrepo'],
    ['git st & echo x > .git/config', 'qrepo'],
    ['echo x > ../qinc.cfg && git st', 'qrepo'],
    ['git st > ../qinc.cfg', 'qrepo'],
    ['git st & echo x > ../qinc.cfg', 'qrepo'],
    ['coproc git st; echo x > ../qinc.cfg', 'qrepo'],
    ['git worktree repair && git st', 'qrepo'],
    ['git stash && git st', 'irepo'],
    ['git checkout -- inc.cfg && git st', 'irepo'],
    ['git st & git reset --hard', 'irepo'],
    ['export GIT_CONFIG_NOSYSTEM=1; git st', 'qrepo'],
  ])(
    'asks in every mode for %s (in proj/%s), whose git alias the scan cannot read as git runs it',
    async (command, folder) => {
      expect(await judge(command, folder)).toMatchObject(asks);
    }
  );

  it.each([
    'git st',
    'git ST',
    'git st --short',
    'git lg -5',
    'git lq -3',
    'git co main',
    'git tabbed',
    'git show-branch',
    'git st && git lg -1',
    'git st | head -1',
    'git add -A && git ci -m x',
    'echo x > out.txt && git st',
    'git stash && git st',
    'git st | tee status.txt',
    'coproc git st',
    'git log --grep=GIT_PAGER && git st',
    'mkdir -p x && git st',
    'rm -f out.txt && git st',
    'git worktree prune && git st',
  ])('runs %s (in proj/qrepo) unasked, reading the git alias it names as git expands it', async command => {
    expect(await judge(command, 'qrepo')).toMatchObject({ auto: true, full: true });
  });

  it('runs a mistyped command unasked where help.autocorrect only names its guess', async () => {
    expect(await judge('git cleen -fdx', 'qrepo')).toMatchObject({ auto: true, full: true });
  });

  it('reads an alias over pack-redundant first only where git lists the command as deprecated', async () => {
    let listed = '';
    try {
      listed = execFileSync('git', ['--list-cmds=deprecated'], { encoding: 'utf8' });
    } catch {
      // A git with no such listing runs its own pack-redundant.
    }
    const overridden = listed.split('\n').includes('pack-redundant');
    expect(await judge('git pack-redundant', 'qrepo')).toMatchObject(overridden ? asks : { auto: true, full: true });
    // zrepo autocorrects, which git does only for a name it has no command for.
    expect(await judge('git pack-redundant', 'zrepo')).toMatchObject({ auto: true, full: true });
  });

  it('remembers a command as written only where it names no alias', async () => {
    expect(await judge('git status', 'qrepo')).toMatchObject({ auto: true, full: true, allowed: true });
    expect(await judge('git st', 'qrepo')).toMatchObject({ auto: true, full: true, allowed: false });
  });

  it('reads a git alias for push as the push it expands to', async () => {
    const push = await judge('git push origin main', 'qrepo');
    expect(await judge('git p origin main', 'qrepo')).toMatchObject({ auto: push.auto, full: push.full });
    expect(await judge('git p https://example.invalid/r main', 'qrepo')).toMatchObject({ auto: false, full: true });
  });

  it.each([
    'git help clean',
    'git --help clean',
    'git -h clean',
    'git --version',
    'git --exec-path',
    'git --exec-path status',
    'git -c core.x=y help clean',
  ])('runs %s unasked, as no program is named', async command => {
    expect(await judge(command)).toMatchObject({ auto: true, full: true });
  });

  it.each([
    'git --no-literal-pathspecs ls-files',
    'git --no-literal-pathspecs status',
    'git --literal-pathspecs ls-files',
    'git --glob-pathspecs ls-files',
    'git --noglob-pathspecs ls-files',
    'git --icase-pathspecs ls-files',
    'git --no-replace-objects log',
    'git --no-lazy-fetch status',
    'git --no-advice status',
    'git --no-optional-locks status',
    'git --version clean -fdx',
    'git -v clean -fdx',
    'git --help clean -fdx',
    'git -h clean -fdx',
    'git --version',
    'git --help',
  ])('runs %s unasked, as git reads it as a read-only command', async command => {
    expect(await judge(command, 'brepo')).toMatchObject({ auto: true, full: true });
  });

  it.each([
    ['git clean -fdx', ''],
    ['git clean -fdx src', ''],
    ['git clean -fdX -e a', 'brepo'],
    ['git rm src/a.ts', ''],
    ['git mv src/a.ts src/z.ts', ''],
    ['git mv src/b.ts .', 'srepo'],
    ['git rm src/b.ts', 'trepo'],
  ])('runs %s (in proj/%s) unasked, naming no protected path', async (command, folder) => {
    expect(await judge(command, folder)).toMatchObject({ auto: true, full: true });
  });

  it.each([
    'git diff --name-only \\--output=.claude/settings.json',
    'git diff --outp\\ut=.claude/settings.json HEAD~1',
    'git diff "--output"=.claude/settings.json HEAD~1',
    'git log \\--output=.claude/settings.json -1',
    'git log -\\-output=.claude/settings.json -1',
    'git diff --o\\utput .claude/settings.json HEAD~1',
    'git diff --output\\=.claude/settings.json HEAD~1',
    'git diff --out""put=.claude/settings.json HEAD~1',
    "git diff --out''put=.claude/settings.json HEAD~1",
    'git show \\--output=.claude/settings.json HEAD',
    'git -C . diff \\--output=.claude/settings.json',
    'git --no-pager diff \\--output=.claude/settings.json',
    'git diff --{output,x}=.claude/settings.json HEAD~1',
    'git diff {--output=.claude/settings.json,HEAD~1}',
    'git diff \\--output=~/proj/grepo/.claude/settings.json HEAD~1',
    'git diff \\--output=.claude/settings.js? HEAD~1',
    'git \\-c core.fsmonitor=x status',
    'git -c core.fsm\\onitor=x status',
    'git -c "$X" status',
    'sort \\-o .claude/settings.json src/b.ts',
    'sort --outp\\ut=.claude/settings.json src/b.ts',
    'iconv -f utf8 -t utf8 \\-o .claude/settings.json src/b.ts',
    'tree \\-o .claude/settings.json',
    'sed -n 1p \\-i .claude/settings.json',
    'rg --pr\\e=./x foo',
    'rg \\--pre ./x foo',
    'rsync \\-e ./x src/ dst/',
    'tar \\-T list -cf out.tgz',
    'tar --files-fr\\om=list -cf out.tgz',
    'git --attr-source HEAD -c core.fsmonitor=x status',
    'git --attr-source HEAD \\-c core.fsmonitor=x status',
    'tree -Lo$X 2 .claude/settings.json',
    'tree -Io$X x .claude/settings.json',
    'tar -cf out.tar \\-I{./x,./x} src',
    'tar -cf out.tar \\-I ./x src',
    'tar -cf out.tar \\-F ./x src',
    'tar -xf x.tar "--to-command"=./x',
    'tar -xf x.tar \\--to-command=./x',
    'tar -xf x.tar \\--to-com=./x',
    'tar -cf out.tar \\--use-compress=./x src',
    'tar -cf out.tar --checkpoint-act\\ion=exec=./x src',
    'tar c\\If ./x out.tar src',
    'tree \\-I{o,o} .claude/settings.json',
    'tree \\-P{o,o} .claude/settings.json',
    'tree \\-H{o,o} .claude/settings.json',
    'tree \\-T{o,o} .claude/settings.json',
    'tree "-I"{o,o} .claude/settings.json',
    "tree '-I'{o,o} .claude/settings.json",
    'tree -\\I{o,o} .claude/settings.json',
    'tree "-P"{o,o} .claude/settings.json',
    'tree -I{o,o} .claude/settings.json',
    'find src -fpr$X .claude/settings.json',
    'find src -fpr$(echo int) .claude/settings.json',
    'find src -f{print,} .claude/settings.json',
    'find src -fl$X .claude/settings.json',
    'find src -fprin? .claude/settings.json',
    'tar --files-fr=list -cf out.tgz',
    'tar --files=list -cf out.tgz',
    'tar -c --files list -f out.tgz',
    'wc --files0-f=list',
    'wc --f=list',
    'sort --fil=list',
    'du --f=list',
  ])('asks for %s, an option word read as bash passes it', async command => {
    expect(await judge(command, 'grepo')).toMatchObject(asks);
  });

  it.each([
    'sort -o* src/b.ts',
    'sort --o{utput,x}=.claude/settings.json src/b.ts',
    'sort {-o,.claude/settings.json} src/b.ts',
    'iconv -t utf8 -o$OUT src/b.ts',
    'git format-patch -o* -1',
    'git format-patch --output-directory={.claude,x} -1',
    'git --config-env=core.fsmonitor=$V status',
    'rg --pre{,-glob}=./x foo',
    'tar -czf out.tgz -{-files-from=list,x}',
    'tar c$X out.tgz src',
    'tar -cf out.tar --$X src',
    'tar --fi* -cf out.tar',
    'rg --$X ./x foo',
    'rsync --$X ./x src/ dst/',
    'rg ${X:+}--pre=./x foo',
    'git ${X:+}-c core.fsmonitor=x status',
    'git $(true)-c core.fsmonitor=x status',
    'git ${X:+}--config-env=core.fsmonitor=HOME status',
    'sort ${X:+}-o .claude/settings.json src/b.ts',
    'sort $(true)--output=.claude/settings.json src/b.ts',
    'iconv -t utf8 ${X:+}-o .claude/settings.json src/b.ts',
    'X=; rg ${X}--pre=./x foo',
    'uniq -$X src/b.ts .claude/settings.json',
  ])('asks for %s, an option whose name bash may still change', async command => {
    expect(await judge(command, 'grepo')).toMatchObject(asks);
  });

  it.each([
    'tar --exclude=*.log -czf out.tgz src',
    'tar -czf out.tgz --exclude=node_modules/* src',
    'tar czf out.tgz --exclude=*.log src',
    'tar -czf out.tgz src --exclude=*.test.ts',
    'tar -czf out.tgz --exclude={a,b} src',
    'sort -k$N src/b.ts',
    'sort -t"$sep" -k2 src/b.ts',
    'iconv -f$ENC -t utf8 src/b.ts',
    'shuf -n$N src/b.ts',
    'git format-patch --output-directory=~/proj/patches -1',
    'git --git-dir="$PWD/.git" log -1',
    'tree -L 2',
    'tree -L$N .',
    'tree -I node_modules',
    'tar -tzf x.tgz',
    'tar -xzf x.tgz -C dir',
    'for f in src/*.ts; do echo "--- $f ---"; head -5 "$f"; done',
    'echo "--- $f"',
    'echo "-- $(date) --"',
    'printf \'%s\\n\' "--- $f ---"',
    'echo "--- $(basename $PWD) ---"; git status',
    'cargo build --${PROFILE}',
    'npm test --$X',
    'make --$X',
    'git log --$X',
    'ls --c*',
    'npx prettier --{check,write} src',
    'rg --files',
    'rg $pattern-foo src',
    'rsync -a --force src/ dst/',
  ])('runs %s unasked, an option bash cannot change to another', async command => {
    expect(await judge(command, 'grepo')).toMatchObject({ auto: true, full: true });
  });

  it.each([
    ['git diff HEAD~1', unasked],
    ['git log --oneline -5', unasked],
    ['git diff --stat', unasked],
    ['git show HEAD:src/b.ts', unasked],
    ["git diff -- 'src/*.ts'", unasked],
    ["git log --format='%h %s'", unasked],
    ['git diff "HEAD~1" -- src', unasked],
    ['sort -u src/b.ts', { auto: true, full: true }],
    ['sort -t, -k2 src/b.ts', { auto: true, full: true }],
    ['uniq -c src/b.ts', { auto: true, full: true }],
    ["sed -n '1,5p' src/b.ts", unasked],
  ])('runs %s unasked', async (command, expected) => {
    expect(await judge(command, 'grepo')).toMatchObject(expected);
  });

  it.each([
    'rg -l foo 2>"/dev/stdout" | xargs sed -i s/a/b/',
    'rg -l foo 2>"$OUT" | xargs sed -i s/a/b/',
    "rg -l foo | grep -E '( docs/secret' 2>/dev/stdout | xargs sed -i s/a/b/",
    // A `..` after a link leads to the link target's parent, which may be /dev.
    'rg -l foo 2>src/../err | xargs sed -i s/a/b/',
    'rg -l foo | grep -v zz 2>src/../err | xargs sed -i s/a/b/',
  ])('asks for %s, whose stderr may reach xargs', async command => {
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

  // Planted only for their own row, as no walk of the project could read past them. APFS refuses a name that is not
  // UTF-8 (EILSEQ), so macOS cannot plant one.
  it.skipIf(process.platform === 'darwin').each([
    // `:!<ff>x` is not UTF-8; bash passes its child as `:!<ff>x/a`, an exclude.
    [
      'a folder whose name is not UTF-8',
      'git diff --name-only -- *x/* | xargs sed -i s/a/b/',
      async (repo: string): Promise<Buffer> => {
        const folder = Buffer.concat([Buffer.from(`${repo}/:!`), Buffer.from([0xff]), Buffer.from('x')]);
        await mkdir(folder);
        await writeFile(Buffer.concat([folder, Buffer.from('/a')]), '');
        return folder;
      },
    ],
  ])('asks with %s for %s', async (_, command, plant) => {
    const planted = await plant(join(proj, 'srepo'));
    try {
      expect(await judge(command, 'srepo')).toMatchObject(asks);
    } finally {
      await rm(planted, { recursive: true, force: true });
    }
  });

  // bash reads BASHOPTS from its environment at startup, and `bash -c` runs the file BASH_ENV names first.
  it.each([
    ['BASHOPTS', 'nullglob', 'git diff --name-only -- src/*.ts | xargs sed -i s/a/b/', ''],
    ['BASHOPTS', 'globstar', 'git diff --name-only -- src/**/*.ts | xargs sed -i s/a/b/', ''],
    ['BASHOPTS', 'nocaseglob', 'git diff --name-only -- *k* | xargs sed -i s/a/b/', 'srepo'],
    ['BASH_ENV', '/dev/null', 'git diff --name-only -- *.zz | xargs sed -i s/a/b/', ''],
    ['BASH_ENV', '/dev/null', 'git diff --name-only -- **/w | xargs sed -i s/a/b/', ''],
    // dotglob lets `*` match `.claude`; under nullglob a pattern with no match drops out, so find starts at `.`.
    ['BASHOPTS', 'dotglob', 'rm -rf *', 'srepo'],
    ['BASHOPTS', 'dotglob', 'chmod -R 000 *', 'srepo'],
    ['BASH_ENV', '/dev/null', 'rm -rf *', 'srepo'],
    ['BASHOPTS', 'nullglob', 'find src/*.zz -delete', ''],
    ['BASHOPTS', 'nullglob', 'ls src/*.zz | xargs chmod -R 000', ''],
    ['BASHOPTS', 'nullglob', 'cd src/*.zz && rm -rf *', ''],
    ['BASH_ENV', '/dev/null', 'find src/*.zz -delete', ''],
    ['BASH_ENV', '/dev/null', 'git ls-files src | xargs wc -l', 'srepo'],
    // git reads these from its environment, and the scan's own git runs read none of them.
    ['GIT_ICASE_PATHSPECS', '1', "git diff --name-only -- '*.JSON' | xargs sed -i s/a/b/", 'srepo'],
    ['GIT_ICASE_PATHSPECS', 'true', "git diff --name-only '*.JSON' | xargs sed -i s/a/b/", 'srepo'],
    ['GIT_ICASE_PATHSPECS', '1', "git ls-files '*.JSON' | xargs sed -i s/a/b/", 'srepo'],
    ['GIT_ICASE_PATHSPECS', '1', "git grep -l x -- '*.JSON' | xargs sed -i s/a/b/", 'srepo'],
    ['GIT_GLOB_PATHSPECS', '1', "git diff --name-only -- '*/**/settings.json' | xargs sed -i s/a/b/", 'srepo'],
    ['GIT_GLOB_PATHSPECS', '1', "git ls-files '*/**/settings.json' | xargs sed -i s/a/b/", 'srepo'],
    ['GIT_GLOB_PATHSPECS', '1', "git grep -l x -- '*/**/settings.json' | xargs sed -i s/a/b/", 'srepo'],
  ])('with %s=%s asks for %s (in proj/%s)', async (variable, value, command, folder) => {
    vi.stubEnv(variable, value);
    try {
      expect(await judge(command, folder)).toMatchObject(asks);
    } finally {
      vi.stubEnv(variable, undefined);
    }
  });

  // Each setting leaves what the command reaches as it was: no pathspec, a pattern with a match, or a narrower read.
  it.each([
    ['BASHOPTS', 'nullglob', 'rm -rf *', 'srepo'],
    ['BASHOPTS', 'nullglob', 'find src/*.ts -delete', ''],
    ['BASHOPTS', 'nullglob', 'ls src/*.ts | xargs wc -l', ''],
    ['GIT_ICASE_PATHSPECS', '1', 'git diff --name-only | xargs cat', ''],
    ['GIT_ICASE_PATHSPECS', '0', 'git ls-files src | xargs wc -l', ''],
    ['GIT_GLOB_PATHSPECS', '1', 'git ls-files | xargs wc -l', ''],
    ['GIT_LITERAL_PATHSPECS', '1', 'git diff --name-only -- src | xargs wc -l', 'srepo'],
    ['GIT_NOGLOB_PATHSPECS', '1', 'git diff --name-only -- src/*.ts | xargs wc -l', ''],
    ['GIT_NOGLOB_PATHSPECS', '1', "git ls-files '*.ts' | xargs wc -l", ''],
  ])('with %s=%s still runs %s (in proj/%s) unasked', async (variable, value, command, folder) => {
    vi.stubEnv(variable, value);
    try {
      expect(await judge(command, folder)).toEqual(unasked);
    } finally {
      vi.stubEnv(variable, undefined);
    }
  });

  // krepo tracks a link in a folder named `:(top)d`, now pointing at the app's data, and has an untracked `DD`
  // holding a link to the same file beside an untracked `dd`. `DD` cannot sit beside `dd` where case folds.
  it.for([
    ['GIT_LITERAL_PATHSPECS', "git diff --name-only -- ':(top)d' | xargs cat", asks],
    ['GIT_ICASE_PATHSPECS', 'git ls-files -o dd | xargs cat', asks],
    ['nothing', "GIT_LITERAL_PATHSPECS=1 git diff --name-only -- ':(top)d' | xargs cat", asks],
    ['nothing', 'GIT_ICASE_PATHSPECS=1 git ls-files -o dd | xargs cat', asks],
    ['nothing', 'GIT_ICASE_PATHSPECS=1 git grep -l --untracked x -- dd | xargs cat', asks],
    ['nothing', "git diff --name-only -- ':(top)d' | xargs cat", { auto: true, full: true }],
    ['nothing', 'git ls-files -o dd | xargs cat', { auto: true, full: true }],
  ] as const)(
    'with %s set decides %s by the links git then prints',
    async ([variable, command, expected], { skip }) => {
      const casePair = / dd\b/.test(command);
      skip(casePair && !tmpKeepsCase, 'the temp folder folds case');
      const krepo = join(proj, 'krepo');
      const vault = join(userData, 'vault.json');
      const git = (...args: string[]): void => {
        execFileSync('git', ['-C', krepo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 't',
            GIT_AUTHOR_EMAIL: 't@t',
            GIT_COMMITTER_NAME: 't',
            GIT_COMMITTER_EMAIL: 't@t',
          },
        });
      };
      await mkdir(krepo);
      if (variable !== 'nothing') vi.stubEnv(variable, '1');
      try {
        await writeFile(vault, '{}');
        await writeFile(join(krepo, 'a'), 'a');
        await mkdir(join(krepo, ':(top)d'));
        await symlink('../a', join(krepo, ':(top)d', 'lk'));
        git('init', '-q', '-b', 'main');
        git('add', '-A');
        git('commit', '-qm', 'first');
        await rm(join(krepo, ':(top)d', 'lk'));
        await symlink(vault, join(krepo, ':(top)d', 'lk'));
        if (casePair) {
          await mkdir(join(krepo, 'dd'));
          await writeFile(join(krepo, 'dd', 'x'), 'x');
          await mkdir(join(krepo, 'DD'));
          await symlink(vault, join(krepo, 'DD', 'lk'));
        }
        expect(await judge(command, 'krepo')).toMatchObject(expected);
      } finally {
        if (variable !== 'nothing') vi.stubEnv(variable, undefined);
        await rm(krepo, { recursive: true, force: true });
        await rm(vault, { force: true });
      }
    }
  );

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

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

// Each row's cells: a rule `Bash(<program>:*)` covers it, then auto mode, auto mode with a session, full mode (r runs, a asks).
const ROWS: [string, string, string][] = [
  ['source ./env5.sh && rm -rf dist', '', 'aaaa'],
  ['source ./env6.sh && rm -rf dist', '', 'aaaa'],
  ['source $PWD/env5.sh && rm -rf dist', '', 'aaaa'],
  ['source ./env5.sh && rm -rf .ssh', '', 'aaaa'],
  ['source ./env5.sh && echo x > .bashrc', '', 'aaaa'],
  ['. ./env5.sh && rm -rf dist', '', 'aaaa'],
  ['source ./env7.sh && rm -rf dist', '', 'aaaa'],
  ['source .venv/bin/activate && rm -rf dist', '', 'aaaa'],
  ['source .venv/bin/activate && git st', '', 'raar'],
  ['. .venv/bin/activate && git st', '', 'raar'],
  ['source .uvenv/bin/activate && git st', '', 'raar'],
  ['source env1.sh && git st', '', 'raar'],
  ['source env3.sh && git st', '', 'raar'],
  ['source env1.sh && git status', '', 'rrrr'],
  ['source ./env1.sh && npm test', '', 'rrrr'],
  ['. ./env3.sh && ls', '', 'rrrr'],
  ['git clone ../origin.git cl', 'src', 'rrrr'],
  ['git clone ../origin.git', 'src', 'rrrr'],
  ['git clone ../origin.git cl && cd cl && ls', 'src', 'rrrr'],
  ['git clone ../origin.git cl && cd cl && npm install', 'src', 'rrrr'],
  ['git clone ../origin.git cl && cd cl && git status', 'src', 'rrrr'],
  ['git clone ../origin.git cl && git -C cl status', 'src', 'rrrr'],
  ['git clone blay/.bare cl3 && cd cl3 && ls', '', 'rrrr'],
  ['git worktree add wt3 -b z && cd wt3 && git st', '', 'rrrr'],
  ['git init newrepo && git -C newrepo st', '', 'rrrr'],
  ['git clone origin.git cl4 && git -C cl4 st', '', 'rrrr'],
  ['git clone ../origin.git cl && git -C cl st', 'src', 'rrrr'],
  ['git clone --template=tpl2 origin.git cl5 && git -C cl5 st', '', 'aaaa'],
  ['git init --template=tpl2 newr2 && git -C newr2 st', '', 'aaaa'],
  ['git -c init.templateDir=tpl2 init newr3 && git -C newr3 st', '', 'aaaa'],
  ['git init --separate-git-dir=sg newr4 && git -C newr4 st', '', 'aaaa'],
  ['git clone -c alias.st=status origin.git cl6 && git -C cl6 st', '', 'aaaa'],
  ['rsync -a --exclude node_modules src/ dist/ && git st', '', 'rrrr'],
  ['cp -r src/* dist/ && git st', '', 'rrrr'],
  ['cp -r src dist && git st', '', 'rrrr'],
  ['rsync -a src/ dist/ && git st', '', 'rrrr'],
  ['cp -r tpl2/. dist/ && git st', '', 'rrrr'],
  ['rsync -a -e ssh src/ dist/ && git st', '', 'aaaa'],
  ['cp -r -t dist src && git st', '', 'rrrr'],
  ['cp -r lrepo dist2 && git st', '', 'aaaa'],
  ['cp -r lrepo/* dist2/ && git st', '', 'rrrr'],
  ['cp -r lrepo/. dist2/ && git st', '', 'aaaa'],
  ['git merge -s foo other', '', 'aaaa'],
  ['git pull -s foo origin main', '', 'aaaa'],
  ['git rebase --strategy=foo main', '', 'aaaa'],
  ['git cherry-pick --strategy=foo other', '', 'aaaa'],
  ['git revert --strategy foo HEAD', '', 'aaaa'],
  ['git pull -s ort origin main', '', 'rrrr'],
  ['git pull --rebase origin main', '', 'rrrr'],
  ['git rebase -s recursive main', '', 'rrrr'],
  ['git cherry-pick -s other', '', 'rrrr'],
  ['git merge -s ours other', '', 'rrrr'],
  ['git pull -sfoo origin main', '', 'aaaa'],
  ['git rebase -s foo main', '', 'aaaa'],
  ['git status', '', 'rrrr'],
  ['git log --oneline -5', '', 'rrrr'],
  ['git diff', '', 'rrrr'],
  ['git add -A', '', 'rrrr'],
  ['git add src/a.ts', '', 'rrrr'],
  ['git commit -m x', '', 'rrrr'],
  ['git switch other', '', 'rrrr'],
  ['git checkout other', '', 'rrrr'],
  ['git checkout -b feat', '', 'rrrr'],
  ['git stash', '', 'rrrr'],
  ['git stash pop', '', 'aaaa'],
  ['git rebase main', '', 'rrrr'],
  ['git rebase -i main', '', 'aaaa'],
  ['git fetch', '', 'rrrr'],
  ['git fetch origin', '', 'rrrr'],
  ['git pull', '', 'rrrr'],
  ['git pull origin main', '', 'rrrr'],
  ['git push', '', 'raar'],
  ['git push origin main', '', 'raar'],
  ['git push -u origin main', '', 'raar'],
  ['git st', '', 'rrrr'],
  ['git lg -3', '', 'rrrr'],
  ['git co other', '', 'rrrr'],
  ['git p', '', 'raar'],
  ['git st && git lg', '', 'rrrr'],
  ['git add -A && git commit -m x && git p', '', 'raar'],
  ['git commit -am x && git st', '', 'rrrr'],
  ['git switch other && git st', '', 'rrrr'],
  ['git co other && git st', '', 'rrrr'],
  ['git pull && git st', '', 'rrrr'],
  ['git rm a.ts && git st', '', 'rrrr'],
  ['git mv a.ts b.ts && git st', '', 'rrrr'],
  ['git reset --hard', '', 'rrrr'],
  ['git restore a.ts', '', 'rrrr'],
  ['git branch -d feat', '', 'rrrr'],
  ['git tag v1', '', 'rrrr'],
  ['git clean -fd', '', 'rrrr'],
  ['pnpm test', '', 'rrrr'],
  ['pnpm lint', '', 'rrrr'],
  ['pnpm build', '', 'rrrr'],
  ['pnpm install', '', 'rrrr'],
  ['pnpm --filter x test', '', 'rrrr'],
  ['npm test', '', 'rrrr'],
  ['npm ci', '', 'rrrr'],
  ['npm run build', '', 'rrrr'],
  ['npx vitest run', '', 'rrrr'],
  ['npx tsc --noEmit', '', 'rrrr'],
  ['npx eslint .', '', 'rrrr'],
  ['npx prettier --check .', '', 'rrrr'],
  ['vitest run', '', 'rrrr'],
  ['tsc --noEmit', '', 'rrrr'],
  ['eslint src', '', 'rrrr'],
  ['prettier --write src', '', 'rrrr'],
  ['mkdir -p build/out', '', 'rrrr'],
  ['touch a.txt', '', 'rrrr'],
  ['cp a.ts b.ts', '', 'rrrr'],
  ['cp -r src build', '', 'rrrr'],
  ['mv a.ts c.ts', '', 'rrrr'],
  ['ln -s a.ts l', '', 'rrrr'],
  ['ln a.ts hard', '', 'rrrr'],
  ['rsync -a src/ build/', '', 'rrrr'],
  ['rm -rf dist', '', 'rrrr'],
  ['rm a.ts', '', 'rrrr'],
  ['ls -la', '', 'rrrr'],
  ['cat a.ts', '', 'rrrr'],
  ['echo hi > out.txt', '', 'arrr'],
  ['export PATH="$HOME/.cargo/bin:$PATH" && git st', '', 'arrr'],
  ['export PATH="$PWD/node_modules/.bin:$PATH" && pnpm test', '', 'arrr'],
  ['PATH=./tools:$PATH git st', '', 'arrr'],
  ['export PATH="$HOME/x:$PATH"; git st', '', 'arrr'],
  ['cd src && git st', '', 'rrrr'],
  ['cd src && git status && cd .. && git lg', '', 'rrrr'],
  ['mkdir x && cd x && git st', '', 'rrrr'],
  ['mkdir -p tmp/a && cd tmp/a && git status', '', 'rrrr'],
  ['git status && pnpm test && git st', '', 'rrrr'],
  ['pnpm build && git add -A && git commit -m build && git p', '', 'raar'],
  ['git fetch && git rebase origin/main && pnpm test && git p', '', 'aaaa'],
  ['cd lrepo && git st && cd ..', '', 'rrrr'],
  ['git -C lrepo st', '', 'rrrr'],
  ['git -C src st', '', 'rrrr'],
  ['for d in src lrepo; do git -C "$d" st; done', '', 'arrr'],
];

describe('shell approval of git programs, sourced files and fresh folders', () => {
  let base: string;
  let proj: string;
  let userData: string;
  let rules: PermissionRuleSet;
  let roots: readonly string[];

  const file = (path: string, text: string, mode = 0o644): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    chmodSync(path, mode);
  };

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'b4m-gitprog-')));
    const home = join(base, 'home');
    proj = join(home, 'proj');
    userData = join(home, '.config', 'Bike4Mind');
    mkdirSync(userData, { recursive: true });
    mkdirSync(join(proj, 'src'), { recursive: true });
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
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
    const repository = (dir: string, files: Record<string, string>): void => {
      for (const [name, text] of Object.entries(files)) file(join(dir, name), text);
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'first');
      for (const [name, value] of [
        ['st', 'status'],
        ['lg', 'log --oneline'],
        ['co', 'checkout'],
        ['p', 'push'],
      ]) {
        git(dir, 'config', `alias.${name}`, value);
      }
    };
    repository(proj, { 'src/a.ts': 'a', 'a.ts': 'a', '.gitignore': 'node_modules\ndist\n', 'dist/x.js': 'x' });
    git(proj, 'branch', 'other');
    repository(join(proj, 'lrepo'), { 'x.ts': 'x' });
    file(join(proj, 'env1.sh'), 'export FOO=1\n');
    file(join(proj, 'env3.sh'), 'X=1\nY=2\n');
    file(join(proj, 'env5.sh'), 'X=1\n\\cd ..\n');
    file(join(proj, 'env6.sh'), "X=1\nc''d ..\n");
    file(join(proj, 'env7.sh'), 'export PATH="./pbin:$PATH"\n');
    file(join(proj, 'pbin', 'rm'), '#!/bin/sh\nexit 0\n', 0o755);
    file(
      join(proj, '.venv', 'bin', 'activate'),
      '# source bin/activate\nVIRTUAL_ENV=/x\nexport VIRTUAL_ENV\nPATH="$VIRTUAL_ENV/bin:$PATH"\nexport PATH\nhash -r 2> /dev/null\n'
    );
    file(
      join(proj, '.uvenv', 'bin', 'activate'),
      'deactivate () { :; }\nVIRTUAL_ENV=/x\nexport VIRTUAL_ENV\n_OLD_VIRTUAL_PATH="$PATH"\nPATH="$VIRTUAL_ENV/bin:$PATH"\nexport PATH\nhash -r 2> /dev/null\n'
    );
    file(join(proj, 'nbin', 'git-merge-foo'), '#!/bin/sh\nexit 1\n', 0o755);
    vi.stubEnv('PATH', `nbin:${process.env.PATH}`);
    execFileSync('git', ['clone', '-q', '--bare', proj, join(proj, 'origin.git')], { env });
    execFileSync('git', ['clone', '-q', '--bare', proj, join(proj, 'blay', '.bare')], { env });
    file(join(proj, 'blay', '.git'), 'gitdir: ./.bare\n');
    file(join(proj, 'tpl2', 'f'), 'f');
    roots = permissionProtectedLocations(userData, home, join(base, 'managed'), { warn: () => {} }).paths();
    const compiled: CompiledRule[] = [];
    for (const program of [
      'git',
      'cp',
      'printf',
      'mkdir',
      'echo',
      'rsync',
      'mv',
      'rm',
      'ls',
      'cat',
      'source',
      '.',
      'npm',
      'pnpm',
      'npx',
      'touch',
      'ln',
      'vitest',
      'tsc',
      'eslint',
      'prettier',
    ]) {
      const parsed = parseRule(`Bash(${program}:*)`, { native: program === 'git' });
      if (!parsed.ok) throw new Error(parsed.reason);
      const rule = compileRule(parsed.rule, 'allow', { id: 't', label: 'T' }, { home, root: proj, cwd: proj });
      if (rule) compiled.push(rule);
    }
    rules = new PermissionRuleSet(compiled, () => roots);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  const cells = async (command: string, folder: string): Promise<string> => {
    const cwd = join(proj, folder);
    const context = (sessionId?: string): ToolContext =>
      ({
        roots: [proj],
        workingDirectory: cwd,
        signal: new AbortController().signal,
        protectedPaths: [userData],
        uncoverablePaths: roots,
        ...(sessionId ? { sessionId } : {}),
      }) as ToolContext;
    const prompt = await shellApproval('bash_execute', { command, cwd }, context());
    const withSession = await shellApproval('bash_execute', { command, cwd }, context('s1'));
    const subject = await resolveSubject(
      permissionSubject({ name: 'bash_execute', input: { command } }, prompt, context())
    ).catch(() => null);
    const covered = subject !== null && rules.evaluate(subject).decision === 'allow';
    return [
      covered,
      !prompt.askInAuto,
      !withSession.askInAuto && (withSession.always?.directories ?? []).length === 0,
      !prompt.askInFull,
    ]
      .map(run => (run ? 'r' : 'a'))
      .join('');
  };

  it.each(ROWS)('decides %s (in proj/%s) as %s', async (command, folder, expected) => {
    expect(await cells(command, folder)).toBe(expected);
  });
});

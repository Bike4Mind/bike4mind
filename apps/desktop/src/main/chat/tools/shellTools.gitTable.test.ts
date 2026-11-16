import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { permissionProtectedLocations } from '../protectedLocations';
import { compileRule, parseRule, PermissionRuleSet, type CompiledRule } from '../permissions/rules';
import { resolveSubject } from '../permissions/resolveSubject';
import { permissionSubject } from '../permissions/subject';
import { runsCheckedInAuto, runsCheckedInFull } from './shellApproval.testHelper';
import { shellApproval } from './shellTools';
import type { ToolContext } from './types';

vi.mock('./userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('./userPath')>()),
  resolveUserPath: vi.fn(async () => process.env.PATH ?? ''),
}));

// Each row's cells: a rule `Bash(<program>:*)` covers it, then auto mode, auto mode with a session, full mode (r runs, a asks).
const ROWS: [string, string, string][] = [
  ['git status', '', 'rrrr'],
  ['git status --short', '', 'rrrr'],
  ['git status -sb', '', 'rrrr'],
  ['git status --porcelain', '', 'rrrr'],
  ['git status', 'src', 'rrrr'],
  ['git diff', '', 'rrrr'],
  ['git diff --stat', '', 'rrrr'],
  ['git diff --cached', '', 'rrrr'],
  ['git diff --staged --name-only', '', 'rrrr'],
  ['git diff HEAD~1', '', 'rrrr'],
  ['git diff main...HEAD', '', 'rrrr'],
  ['git diff origin/main -- src/a.ts', '', 'rrrr'],
  ['git diff --name-status main', '', 'rrrr'],
  ['git diff -U0 a.ts', '', 'rrrr'],
  ['git diff --word-diff', '', 'rrrr'],
  ['git diff --no-color HEAD -- a.ts', '', 'rrrr'],
  ['git diff -- a.ts', 'src', 'rrrr'],
  ['git log', '', 'rrrr'],
  ['git log --oneline -10', '', 'rrrr'],
  ['git log --oneline -n 5', '', 'rrrr'],
  ['git log -1 --format=%H', '', 'rrrr'],
  ["git log --format='%h %s' -5", '', 'rrrr'],
  ["git log --pretty=format:'%h %an %s' -3", '', 'rrrr'],
  ['git log --graph --oneline --all -20', '', 'rrrr'],
  ['git log --stat -3', '', 'rrrr'],
  ['git log -p -2 -- src/a.ts', '', 'rrrr'],
  ['git log main..HEAD --oneline', '', 'rrrr'],
  ["git log --since='2 weeks ago' --oneline", '', 'rrrr'],
  ['git log --grep=fix --oneline', '', 'rrrr'],
  ['git log -S parse --oneline', '', 'rrrr'],
  ['git log --follow -- a.ts', '', 'rrrr'],
  ['git log --oneline | head -5', '', 'rrrr'],
  ['git log --oneline -5 2>&1', '', 'rrrr'],
  ['git show', '', 'rrrr'],
  ['git show HEAD', '', 'rrrr'],
  ['git show --stat HEAD', '', 'rrrr'],
  ['git show HEAD:a.ts', '', 'rrrr'],
  ['git show --name-only HEAD~1', '', 'rrrr'],
  ['git show v1', '', 'rrrr'],
  ['git branch', '', 'rrrr'],
  ['git branch -a', '', 'rrrr'],
  ['git branch -vv', '', 'rrrr'],
  ['git branch --show-current', '', 'rrrr'],
  ['git branch -r', '', 'rrrr'],
  ['git branch --merged main', '', 'rrrr'],
  ['git branch --contains HEAD', '', 'rrrr'],
  ['git tag', '', 'rrrr'],
  ["git tag -l 'v*'", '', 'rrrr'],
  ['git tag --sort=-creatordate', '', 'rrrr'],
  ['git remote -v', '', 'rrrr'],
  ['git remote get-url origin', '', 'rrrr'],
  ['git remote show origin', '', 'rrrr'],
  ['git rev-parse HEAD', '', 'rrrr'],
  ['git rev-parse --abbrev-ref HEAD', '', 'rrrr'],
  ['git rev-parse --show-toplevel', '', 'rrrr'],
  ['git rev-parse --short HEAD', '', 'rrrr'],
  ['git rev-list --count HEAD', '', 'rrrr'],
  ['git rev-list --left-right --count origin/main...HEAD', '', 'rrrr'],
  ['git merge-base HEAD origin/main', '', 'rrrr'],
  ['git ls-files', '', 'rrrr'],
  ['git ls-files --others --exclude-standard', '', 'rrrr'],
  ['git ls-files -m', '', 'rrrr'],
  ['git ls-tree -r HEAD --name-only', '', 'rrrr'],
  ['git cat-file -p HEAD', '', 'rrrr'],
  ['git cat-file -t HEAD', '', 'rrrr'],
  ['git blame a.ts', '', 'rrrr'],
  ['git blame -L 1,10 src/a.ts', '', 'rrrr'],
  ['git describe --tags', '', 'rrrr'],
  ['git describe --always --dirty', '', 'rrrr'],
  ['git shortlog -sn', '', 'rrrr'],
  ["git for-each-ref --format='%(refname:short)' refs/heads", '', 'rrrr'],
  ['git show-ref --tags', '', 'rrrr'],
  ['git check-ignore -v dist/x.js', '', 'rrrr'],
  ['git grep -n parse', '', 'rrrr'],
  ['git grep -n parse -- src', '', 'rrrr'],
  ["git grep -l TODO -- '*.ts'", '', 'rrrr'],
  ['git grep -i parse src', '', 'rrrr'],
  ['git config --get user.email', '', 'rrrr'],
  ['git config user.name', '', 'rrrr'],
  ['git config --list', '', 'rrrr'],
  ['git config --get remote.origin.url', '', 'rrrr'],
  ['git stash list', '', 'rrrr'],
  ['git stash show -p', '', 'rrrr'],
  ['git reflog -n 10', '', 'rrrr'],
  ['git worktree list', '', 'rrrr'],
  ['git --version', '', 'arrr'],
  ['git -C src status', '', 'rrrr'],
  ['git --no-pager log -5', '', 'rrrr'],
  ['git --no-pager diff --stat', '', 'rrrr'],
  ['git -c color.ui=never diff', '', 'arrr'],
  ['git status && git diff --stat', '', 'rrrr'],
  ['cd src && git status', '', 'rrrr'],
  ['git diff > changes.patch', '', 'arrr'],
  ['git add a.ts', '', 'rrrr'],
  ['git add -A', '', 'rrrr'],
  ['git add .', '', 'rrrr'],
  ['git add src/', '', 'rrrr'],
  ['git add -u', '', 'rrrr'],
  ['git add *.ts', '', 'rrrr'],
  ['git add src/*.ts', '', 'rrrr'],
  ['git add -A *.md', '', 'rrrr'],
  ['git status -- *.ts', '', 'rrrr'],
  ["git diff -- '*.ts'", '', 'rrrr'],
  ['git diff -- *.ts', '', 'rrrr'],
  ['git log -- src/*.ts', '', 'rrrr'],
  ['git commit -m x -- *.ts', '', 'rrrr'],
  ['git fetch origin -o [+-]*', '', 'aaaa'],
  ['git fetch -o [+-]* origin', '', 'aaaa'],
  ['git commit -m [+-]*', '', 'aaaa'],
  ['git log -n [+-]*', '', 'aaaa'],
  ['git commit -m x *', '', 'aaaa'],
  ['git commit -m x -*', '', 'aaaa'],
  ['git fetch origin ?x', '', 'aaaa'],
  ['git push origin [+-]*', '', 'aaaa'],
  ["git commit -m 'fix: handle empty input'", '', 'rrrr'],
  ["git commit -am 'chore: update'", '', 'rrrr'],
  ['git commit --amend --no-edit', '', 'rrrr'],
  ["git commit -m 'feat: add parser' -m 'Second paragraph.'", '', 'rrrr'],
  ['git commit -F msg.txt', '', 'rrrr'],
  ["git add -A && git commit -m 'wip'", '', 'rrrr'],
  ["git commit --allow-empty -m 'empty'", '', 'rrrr'],
  ['git restore a.ts', '', 'rrrr'],
  ['git restore --staged a.ts', '', 'rrrr'],
  ['git reset HEAD a.ts', '', 'rrrr'],
  ['git reset --soft HEAD~1', '', 'rrrr'],
  ['git reset --hard HEAD', '', 'rrrr'],
  ['git checkout other', '', 'rrrr'],
  ['git checkout -b topic', '', 'rrrr'],
  ['git checkout -- a.ts', '', 'rrrr'],
  ['git checkout main -- src/a.ts', '', 'rrrr'],
  ['git switch other', '', 'rrrr'],
  ['git switch -c topic', '', 'rrrr'],
  ['git branch topic', '', 'rrrr'],
  ['git branch -d other', '', 'rrrr'],
  ['git branch -m other renamed', '', 'rrrr'],
  ['git merge other', '', 'rrrr'],
  ["git merge --no-ff other -m 'merge other'", '', 'rrrr'],
  ['git merge --abort', '', 'aaaa'],
  ['git rebase main', '', 'rrrr'],
  ['git rebase origin/main', '', 'rrrr'],
  ['git rebase --abort', '', 'aaaa'],
  ['git cherry-pick other', '', 'rrrr'],
  ['git cherry-pick --abort', '', 'aaaa'],
  ['git revert --no-edit HEAD', '', 'aaaa'],
  ['git stash', '', 'rrrr'],
  ["git stash push -m 'wip'", '', 'rrrr'],
  ['git stash pop', '', 'aaaa'],
  ['git stash apply', '', 'aaaa'],
  ['git stash drop', '', 'rrrr'],
  ['git stash -u', '', 'rrrr'],
  ['git tag v2', '', 'rrrr'],
  ["git tag -a v3 -m 'release v3'", '', 'rrrr'],
  ['git tag -d v1', '', 'rrrr'],
  ['git rm --cached a.ts', '', 'rrrr'],
  ['git rm a.ts', '', 'rrrr'],
  ['git mv a.ts b.ts', '', 'rrrr'],
  ['git clean -n', '', 'rrrr'],
  ['git clean -fd', '', 'rrrr'],
  ['git worktree add ../wt -b wt', '', 'rrrr'],
  ['git worktree remove ../wt', '', 'rrrr'],
  ['git init newrepo', '', 'rrrr'],
  ['git config user.email t@example.com', '', 'rrrr'],
  ['git apply changes.patch', '', 'rrrr'],
  ['git format-patch -1 HEAD', '', 'rrrr'],
  ['git fetch', '', 'rrrr'],
  ['git fetch origin', '', 'rrrr'],
  ['git fetch --all --prune', '', 'rrrr'],
  ['git fetch origin main', '', 'rrrr'],
  ['git pull', '', 'rrrr'],
  ['git pull --rebase', '', 'rrrr'],
  ['git pull origin main', '', 'rrrr'],
  ['git pull --ff-only', '', 'rrrr'],
  ['git push', '', 'rrrr'],
  ['git push origin HEAD', '', 'rrrr'],
  ['git push -u origin topic', '', 'rrrr'],
  ['git push --force-with-lease', '', 'rrrr'],
  ['git push origin --delete topic', '', 'rrrr'],
  ['git push --tags', '', 'rrrr'],
  ['git ls-remote origin', '', 'rrrr'],
  ['git clone https://example.com/acme/proj.git cl1', '', 'raar'],
  ['git clone --depth 1 https://example.com/acme/proj.git cl2', '', 'raar'],
  ['git remote add fork git@example.com:acme/fork.git', '', 'rrrr'],
  ['git remote set-url origin https://example.com/acme/proj2.git', '', 'rrrr'],
  ['git submodule update --init --recursive', '', 'rrrr'],
  ['git submodule status', '', 'rrrr'],
  ['git fetch && git status', '', 'rrrr'],
  ["git add -A && git commit -m 'x' && git push", '', 'rrrr'],
  ['git ls-tree --name-only $(git merge-base origin/main HEAD)', '', 'rrrr'],
  ['git rev-list --count $(git merge-base origin/main HEAD)..HEAD', '', 'rrrr'],
  ['git diff $(git merge-base origin/main HEAD)..HEAD', '', 'rrrr'],
  ['git log --oneline "$(cat msg.txt)"', '', 'rrrr'],
  ['git log --$X', '', 'rrrr'],
  ['git branch -D "$(cat msg.txt)"', '', 'rrrr'],
  ['git filter-branch --tree-filter true HEAD', '', 'aaaa'],
  ['git filter-repo --path src', '', 'aaaa'],
  ['git instaweb --httpd=./x.sh', '', 'aaaa'],
  ["git remote-ext x 'sh -c true'", '', 'aaaa'],
  ['git fetch-pack --upload-pack=./x.sh . main', '', 'aaaa'],
  ['git send-pack --receive-pack=./x.sh . main', '', 'aaaa'],
  ['git daemon --access-hook=./x.sh', '', 'aaaa'],
  ['git difftool -x ./x.sh HEAD~1', '', 'aaaa'],
  ['git difftool -t ../x HEAD~1', '', 'aaaa'],
  ['git mergetool -t ../x', '', 'aaaa'],
  ['git submodule add foo::x sm', '', 'aaaa'],
  ['find . -name x -exec git filter-branch -f \\;', '', 'aaaa'],
  ['find . -name x -exec git difftool -t ../x \\;', '', 'aaaa'],
  ['echo HEAD | xargs git filter-branch', '', 'aaaa'],
  ['echo x | xargs git daemon --access-hook=./x.sh', '', 'aaaa'],
  ['timeout 5 git instaweb', '', 'aaaa'],
  ['git -C src mergetool --tool=../x', '', 'aaaa'],
];

describe('shell approval of common agent git commands', () => {
  let proj: string;
  let base: string;
  let userData: string;
  let rules: PermissionRuleSet;
  let roots: readonly string[];

  const file = (path: string, text: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'b4m-gittable-')));
    const home = join(base, 'home');
    proj = join(home, 'proj');
    userData = join(home, '.config', 'Bike4Mind');
    mkdirSync(userData, { recursive: true });
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', proj, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
        env,
      });
    };
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
    for (const [name, text] of Object.entries({
      'src/a.ts': 'export const parse = (s: string) => s;\n',
      'a.ts': 'a\n',
      'README.md': '# proj\n',
      'msg.txt': 'chore: message from a file\n',
      'changes.patch': '',
      '.gitignore': 'node_modules\ndist\n',
      'dist/x.js': 'x\n',
    })) {
      file(join(proj, name), text);
    }
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-qm', 'first');
    git('branch', 'other');
    git('tag', 'v1');
    git('remote', 'add', 'origin', 'https://example.com/acme/proj.git');
    git('remote', 'add', 'upstream', 'git@example.com:acme/proj.git');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('config', 'branch.main.remote', 'origin');
    git('config', 'branch.main.merge', 'refs/heads/main');
    const ambient = (process.env.PATH ?? '').split(':').filter(entry => !entry.endsWith('node_modules/.bin'));
    vi.stubEnv('PATH', ambient.join(':'));
    roots = permissionProtectedLocations(userData, home, join(base, 'managed'), { warn: () => {} }).paths();
    const compiled: CompiledRule[] = [];
    for (const program of ['git', 'head', 'cat', 'echo', 'ls']) {
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

  let sessions = 0;
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
    const withSession = await shellApproval('bash_execute', { command, cwd }, context(`s${++sessions}`));
    const subject = await resolveSubject(
      permissionSubject({ name: 'bash_execute', input: { command } }, prompt, context())
    ).catch(() => null);
    const covered = subject !== null && rules.evaluate(subject).decision === 'allow';
    return [
      covered,
      runsCheckedInAuto(prompt),
      runsCheckedInAuto(withSession) && (withSession.always?.directories ?? []).length === 0,
      runsCheckedInFull(prompt),
    ]
      .map(run => (run ? 'r' : 'a'))
      .join('');
  };

  it.each(ROWS)('decides %s (in proj/%s) as %s', async (command, folder, expected) => {
    expect(await cells(command, folder)).toBe(expected);
  });

  it.each([
    'git frobnicate',
    'git status --frobnicate',
    'git log --oneline && git frobnicate -x',
    'pnpm exec git frobnicate',
  ])('asks in every mode for %s, which the safe table does not list', async command => {
    expect(await cells(command, '')).toBe('aaaa');
  });

  it('names an unlisted git form and asks about the whole script in every mode', async () => {
    const context = {
      roots: [proj],
      workingDirectory: proj,
      signal: new AbortController().signal,
      protectedPaths: [userData],
      uncoverablePaths: roots,
    } as ToolContext;
    const prompt = await shellApproval('bash_execute', { command: 'git log -1 && git frobnicate', cwd: proj }, context);
    expect(prompt.detail).toContain('Runs git in a form Desktop does not list as safe (git frobnicate).');
    expect(prompt.byPart).toBeUndefined();
    expect(prompt.askInAuto).toBe(true);
    expect(prompt.askInFull).toBe(true);
    expect(prompt.always?.commands.map(part => part.ask?.kinds ?? [])).toEqual([[], []]);
  });

  // GIT_CELLS=<file> appends every row's current cells to that file, to compare two versions of the scan.
  it.runIf(Boolean(process.env.GIT_CELLS))('writes the cells of every row to GIT_CELLS', async () => {
    const lines: string[] = [];
    for (const [command, folder] of ROWS) lines.push([await cells(command, folder), folder, command].join('\t'));
    appendFileSync(process.env.GIT_CELLS as string, lines.map(line => `${JSON.stringify(line)}\n`).join(''));
  });
});

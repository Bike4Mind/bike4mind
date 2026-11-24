import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { compileRule, parseRule, PermissionRuleSet } from '../permissions/rules';
import { permissionSubject } from '../permissions/subject';
import { runsCheckedInAuto } from './shellApproval.testHelper';
import { shellApproval } from './shellTools';
import type { ToolContext } from './types';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { memoizedExecFile } = await import('./execFileMemo.testHelper');
  return { ...actual, execFile: memoizedExecFile(actual.execFile) };
});
vi.mock('./userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('./userPath')>()),
  resolveLoginShellVariables: async () => ({}),
  resolveUserPath: vi.fn(async () => process.env.PATH ?? ''),
}));

let root: string;
let context: ToolContext;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-git-review-')));
  await mkdir(join(root, 'src'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'alias.p', 'push']);
  execFileSync('git', ['-C', root, 'config', 'alias.bang', '!printf ok']);
  execFileSync('git', ['-C', root, 'config', 'alias.f', 'fetch --upload-pack=./helper']);
  execFileSync('git', ['-C', root, 'config', 'alias.m', 'merge --strategy=custom']);
  execFileSync('git', ['-C', root, 'config', 'alias.st', 'status']);
  const tools = join(root, 'tools');
  await mkdir(tools);
  await writeFile(join(tools, 'git-merge-custom'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  vi.stubEnv('PATH', `${tools}${delimiter}${process.env.PATH ?? ''}`);
  context = { roots: [root], workingDirectory: root, signal: new AbortController().signal };
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const promptFor = (command: string) => shellApproval('bash_execute', { command }, context);

const decision = async (command: string, ruleText: string, list: 'allow' | 'deny' | 'ask') => {
  const parsed = parseRule(ruleText);
  if (!parsed.ok) throw new Error(parsed.reason);
  const rule = compileRule(parsed.rule, list, { id: 'review', label: 'Review' }, { home: root, root, cwd: root });
  if (!rule) throw new Error('Rule did not compile');
  return new PermissionRuleSet([rule]).evaluate(
    permissionSubject({ name: 'bash_execute', input: { command } }, await promptFor(command), context)
  ).decision;
};

describe('git rule and launcher review regressions', () => {
  it.each(['pnpm exec git f origin', 'npm x git f origin', 'npx git m other'])(
    'checks expanded launched options in %s',
    async command => {
      expect(runsCheckedInAuto(await promptFor(command))).toBe(false);
    }
  );
  it.each(['npx printf git bang', 'pnpm exec printf git bang', 'pnpm exec printf node -e 1'])(
    'does not reinterpret an argument as an executable in %s',
    async command => {
      expect((await promptFor(command)).askInAuto).toBeUndefined();
    }
  );
  it.each(['pnpm exec git st', 'npm x git st', 'npx git st'])('keeps the readable launched alias %s', async command => {
    expect((await promptFor(command)).askInAuto).toBeUndefined();
  });
  it.each([
    'git commit -m done; export EDITOR=vim',
    'EDITOR=vim git commit -m done',
    'EDITOR=vim git tag plain',
    'VISUAL=vim git status',
    'git commit -m done; PAGER=less',
  ])('limits fallback settings for %s', async command => {
    expect((await promptFor(command)).askInAuto).toBeUndefined();
  });
  it.each([
    'export EDITOR=vim; git commit',
    'VISUAL=vim git tag -a release',
    'export EDITOR=vim; git branch --edit-description',
    'EDITOR=vim git config --edit',
    'EDITOR=vim git notes edit',
    'for n in 1 2; do git commit; export EDITOR=vim; done',
    'f(){ export EDITOR=vim; }; f; git commit',
  ])('retains actual or uncertain fallback consumers in %s', async command => {
    expect(runsCheckedInAuto(await promptFor(command))).toBe(false);
  });

  it.each([
    ['git p origin main', 'Bash(git push:*)'],
    ['git p origin main > push.log', 'Bash(git push:*)'],
    ['git p origin main 2> err.log', 'Bash(git push:*)'],
    ['FOO=1 git p origin main', 'Bash(git push:*)'],
    ['pnpm exec git p origin main', 'Bash(pnpm exec git push:*)'],
    ['pnpm exec git p origin main > push.log', 'Bash(pnpm exec git push:*)'],
    ['FOO=1 pnpm exec git p origin main', 'Bash(pnpm exec git push:*)'],
    ['npm x git p origin main', 'Bash(npm x git push:*)'],
    ['npx git p origin main 2> err.log', 'Bash(npx git push:*)'],
  ])('retains deny and ask matching for %s', async (command, rule) => {
    expect(await decision(command, rule, 'deny')).toBe('deny');
    expect(await decision(command, rule, 'ask')).toBe('ask');
  });

  it.each([
    'git p origin main > push.log',
    'FOO=1 git p origin main',
    'pnpm exec git p origin main > push.log',
    'FOO=1 pnpm exec git p origin main',
  ])('does not broaden an allow rule for %s', async command => {
    expect(
      await decision(command, command.includes('pnpm') ? 'Bash(pnpm exec git push:*)' : 'Bash(git push:*)', 'allow')
    ).not.toBe('allow');
  });

  it.each([
    'pnpm --filter app exec git bang',
    'pnpm -F app exec git bang',
    'pnpm --filter=app exec git bang',
    'pnpm -w exec git bang',
    'npm --prefix . exec -- git bang',
    'npm x -- git bang',
    'npx --yes git bang',
    'pnpx git bang',
    'yarn exec git bang',
    'bunx git bang',
  ])('checks the executable launched by %s', async command => {
    expect(runsCheckedInAuto(await promptFor(command))).toBe(false);
  });

  it.each([
    'EDITOR=vim git status',
    'PAGER=less git status',
    'export EDITOR=vim; git status',
    'export PAGER=less; git log -1',
    'git status; EDITOR=vim',
    'git status; PAGER=less',
    'git branch --unset-upstream "$BRANCH"',
    'git log --grep=unset -- "$PATHSPEC"',
  ])('does not invent a program environment or unset command in %s', async command => {
    const prompt = await promptFor(command);
    if (!command.includes('$')) expect(prompt.askInAuto).toBeUndefined();
    expect(prompt.detail).not.toContain('Could not read every');
  });

  it.each([
    'EDITOR=vim git commit',
    'PAGER=less git grep -O needle',
    'unset GIT_CONFIG_COUNT; git log',
    'export EDITOR=vim; pnpm exec git commit',
    'export EDITOR=vim; npm x git commit',
  ])('retains the program/config check for %s', async command => {
    expect(runsCheckedInAuto(await promptFor(command))).toBe(false);
  });
});

const DELETE_REASON = 'Deletes files recursively or forcefully, which cannot be undone.';

describe('recursive or forced deletes', () => {
  it.each([
    'rm -rf src',
    'rm -r src',
    'rm -R src',
    'rm -fr src',
    'rm -f src/a.txt',
    'rm --recursive src',
    'rm --force src/a.txt',
    'sudo rm -rf src',
    'find . -name x -delete',
    'find . -delete',
    'find . -exec rm {} \\;',
    'find . -exec rm -rf {} +',
    'ls | xargs rm -rf',
    '/bin/rm -rf src',
    'env X=1 rm -rf src',
    'command rm -rf src',
    'rm --rec src',
    'rm src -rf',
    'ls && rm -rf src',
    'echo $(rm -rf src)',
    'find . -execdir rm {} \\;',
    'find . -ok rm {} \\;',
    // Option words read as bash hands them over: quotes and backslashes inside the word, line continuations.
    'rm "-"rf src',
    'rm -"rf" src',
    String.raw`rm \-rf src`,
    String.raw`rm -\rf src`,
    'rm --"recursive" src',
    "rm '--force' src/a.txt",
    'rm -r\\\nf src',
    'rm \\\n-rf src',
    // A word an expansion, glob or brace may turn into an option.
    'rm -$X src',
    'rm "$X" src',
    'rm ${X:--rf} src',
    'rm -{r,f} src',
    'rm {-r,x} src',
    'rm -[r]f src',
    // Program words and wrappers.
    String.raw`\rm -rf src`,
    '"rm" -rf src',
    'builtin rm -rf src',
    'builtin command rm -rf src',
    'exec rm -rf src',
    'nohup rm -rf src',
    'nice -n 5 rm -rf src',
    'timeout 5 rm -rf src',
    'gtimeout 5 rm -rf src',
    'sudo -u root rm -rf src',
    'env -i rm -rf src',
    // Launchers and runners that start another command.
    'pnpm exec rm -rf src',
    'pnpm exec -- rm -rf src',
    'pnpm --filter x exec rm -rf src',
    'npm exec rm -rf src',
    'npm x rm -rf src',
    "npm exec -c 'rm -rf src'",
    'npx rm -rf src',
    'ls | parallel rm -rf',
    "ls | parallel 'rm -rf {}'",
    "eval 'rm -rf src'",
    'eval rm -rf src',
    "xargs sh -c 'rm -rf src'",
    // find running rm past its wrappers, through xargs or a shell, or with operands of its own.
    'find . -exec env rm {} \\;',
    'find . -exec command rm {} \\;',
    'find . -exec sudo rm {} \\;',
    'find . -exec xargs rm -rf \\;',
    'find . -exec rm -rf src {} +',
    "find . -exec sh -c 'rm -rf {}' \\;",
    // Other programs that delete trees.
    'rimraf dist',
    'npx rimraf dist',
    'pnpm rimraf dist',
    'git clean -fdx',
    'git clean',
    'git -C src clean -fd',
    'git clean -fdx -evendor',
    'git clean -fdx -e -n',
    'git clean -fdx --exclude -n',
    'rsync -a --delete src/ out/',
    'rsync -a --delete-after src/ out/',
    'rsync -a --remove-source-files src/ out/',
  ])('gives %s a reason on the card', async command => {
    const prompt = await promptFor(command);
    expect(prompt.reasons).toContain(DELETE_REASON);
    expect(prompt.detail).toContain(DELETE_REASON);
  });

  it.each([
    'rm src/a.txt',
    'rm -i src/a.txt',
    'rm -v src/a.txt',
    'rm -d src',
    'rm --dir src',
    'ls',
    'find . -name x',
    'find . -fprint out',
    'pnpm test',
    'echo rm -rf src',
    'rm -- -rf',
    'rm ./$X',
    'grep rm -r .',
    'grep -r "rm -rf" .',
    'ls -rf',
    'cp -r src out',
    'pnpm rm -r foo',
    'pnpm exec vitest run',
    'npx tsc --noEmit',
    'timeout 5 ls',
    'gtimeout 5 ls',
    'git status',
    'git clean -n',
    'git clean -fd --dry-run',
    'git clean -fdn',
    'git clean -fne.env',
    'rsync -a src/ out/',
    'eval ls',
    'unlink src/a.txt',
    'rmdir src',
  ])('gives %s no delete reason', async command => {
    expect((await promptFor(command)).reasons ?? []).not.toContain(DELETE_REASON);
  });
});

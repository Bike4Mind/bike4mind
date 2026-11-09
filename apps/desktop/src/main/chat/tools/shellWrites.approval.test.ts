import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { compileRule, parseRule, PermissionRuleSet } from '../permissions/rules';
import { everySessionRules, permissionSubject } from '../permissions/subject';
import { shellApproval } from './shellTools';
import type { ToolContext } from './types';

vi.mock('./userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('./userPath')>()),
  resolveUserPath: vi.fn(async () => process.env.PATH ?? ''),
}));

describe('shell write target approval', () => {
  let root: string;

  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
      stdio: 'pipe',
    });
  };

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-write-targets-')));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'file'), 'safe');
    git('init', '-q', '-b', 'main');
    git('add', 'src');
    git('commit', '-qm', 'main');
    git('checkout', '-qb', 'dirty');
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude', 'settings.json'), '{"changed":true}');
    git('add', '.claude');
    git('commit', '-qm', 'settings');
    git('checkout', '-q', 'main');
    await mkdir(join(root, 'payload', '.claude'), { recursive: true });
    await writeFile(join(root, 'payload', '.claude', 'settings.json'), '{"changed":true}');
    await mkdir(join(root, 'parent', 'project', '.claude'), { recursive: true });
    await writeFile(join(root, 'parent', 'project', '.claude', 'settings.json'), '{}');
    execFileSync('tar', ['-cf', join(root, 'nested.tar'), '-C', join(root, 'payload'), '.claude']);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const judge = async (command: string) => {
    const context: ToolContext = {
      roots: [root],
      workingDirectory: root,
      signal: new AbortController().signal,
    };
    const prompt = await shellApproval('bash_execute', { command, cwd: root }, context);
    const subject = permissionSubject({ name: 'bash_execute', input: { command } }, prompt, context);
    const parsed = parseRule(`Bash(${command.startsWith('git') ? 'git' : 'tar'}:*)`, { native: true });
    if (!parsed.ok) throw new Error(parsed.reason);
    const rule = compileRule(parsed.rule, 'allow', { id: 'test', label: 'Test' }, { home: root, root, cwd: root });
    if (rule === null) throw new Error('Could not compile test rule');
    return {
      auto: !prompt.askInAuto,
      full: !prompt.askInFull,
      allowed: new PermissionRuleSet([rule]).evaluate(subject).decision === 'allow',
      savedRules: everySessionRules(subject, prompt),
    };
  };

  const asks = { auto: false, full: false, allowed: false, savedRules: [] };

  it.each([
    'git worktree add dirty',
    'git worktree add absent',
    'git worktree add -f dirty',
    'git worktree add --guess-remote dirty',
    'git worktree add wt dirty',
    'git worktree add -b new wt dirty',
  ])('asks before %s', async command => {
    expect(await judge(command)).toEqual(asks);
  });

  it.each([
    'git worktree add wt HEAD',
    'git worktree add wt main',
    'git worktree add -d dirty',
    'git worktree add --detach dirty',
    'git worktree add -b new dirty',
    'git worktree add -B new dirty',
    'git worktree add --no-checkout dirty',
    'git worktree add --no-checkout wt dirty',
    'git worktree add --orphan dirty',
  ])('keeps explicit HEAD or no-checkout semantics for %s', async command => {
    expect(await judge(command)).toMatchObject({ auto: true, full: true, allowed: true });
  });

  it('checks the branch selected by the worktree folder name before it is created', async () => {
    expect(await judge('git worktree add dirty')).toEqual(asks);
    git('worktree', 'add', 'dirty');
    expect(await readFile(join(root, 'dirty', '.claude', 'settings.json'), 'utf8')).toBe('{"changed":true}');
  });

  it.each([
    '-C parent -C project',
    '-Cparent -Cproject',
    '--directory parent --directory project',
    '--directory=parent --directory=project',
    '--dir=parent -Cproject',
    '-C parent --directory=project',
    '-C parent -C .',
    '-C parent -C /tmp',
  ])('asks when tar changes extraction directory repeatedly: %s', async options => {
    expect(await judge(`tar -xf nested.tar ${options}`)).toEqual(asks);
  });

  it('asks for the repeated-directory extraction that writes settings', async () => {
    const command = 'tar -xf nested.tar -C parent -C project';
    expect(await judge(command)).toEqual(asks);
    execFileSync('tar', ['-xf', 'nested.tar', '-C', 'parent', '-C', 'project'], { cwd: root });
    expect(await readFile(join(root, 'parent', 'project', '.claude', 'settings.json'), 'utf8')).toBe(
      '{"changed":true}'
    );
  });

  it.each(['-C src', '-Csrc', '--directory=src', '--dir=src'])(
    'keeps a single tar directory readable: %s',
    async options => {
      expect(await judge(`tar -xf missing.tar ${options}`)).toMatchObject({ auto: true, full: true, allowed: true });
    }
  );
});

import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  branchCheckouts,
  checkoutBranch,
  currentBranch,
  git,
  GitError,
  parseWorktreePorcelain,
  readableGitMessage,
  uncommittedChanges,
} from './git';

async function repository(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'b4m-git-')));
  await git(directory, ['init', '--initial-branch=main', '--quiet']);
  await git(directory, ['config', 'user.email', 'test@example.com']);
  await git(directory, ['config', 'user.name', 'Test']);
  await writeFile(join(directory, 'README.md'), 'first\n', 'utf8');
  await git(directory, ['add', '.']);
  await git(directory, ['commit', '--quiet', '-m', 'first']);
  return directory;
}

describe('uncommittedChanges', () => {
  it('is empty for a clean tree, even with an untracked file in it', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'scratch.log'), 'noise\n', 'utf8');

    expect(await uncommittedChanges(directory)).toEqual([]);
  });

  it('names tracked files changed in the tree or in the index', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'README.md'), 'edited\n', 'utf8');
    await writeFile(join(directory, 'added.txt'), 'new\n', 'utf8');
    await git(directory, ['add', 'added.txt']);

    expect((await uncommittedChanges(directory)).sort()).toEqual(['README.md', 'added.txt']);
  });
});

describe('checkoutBranch', () => {
  it('switches onto an existing branch', async () => {
    const directory = await repository();
    await git(directory, ['branch', 'feat/x']);

    await checkoutBranch(directory, 'feat/x', false);

    expect(await currentBranch(directory)).toBe('feat/x');
  });

  it('creates a branch from HEAD and switches onto it', async () => {
    const directory = await repository();

    await checkoutBranch(directory, 'feat/new', true);

    expect(await currentBranch(directory)).toBe('feat/new');
  });

  it('surfaces git refusing a switch that would overwrite an untracked file, and stays put', async () => {
    const directory = await repository();
    await git(directory, ['switch', '--quiet', '-c', 'feat/x']);
    await writeFile(join(directory, 'clash.txt'), 'tracked on feat/x\n', 'utf8');
    await git(directory, ['add', 'clash.txt']);
    await git(directory, ['commit', '--quiet', '-m', 'clash']);
    await git(directory, ['switch', '--quiet', 'main']);
    await writeFile(join(directory, 'clash.txt'), 'untracked on main\n', 'utf8');

    await expect(checkoutBranch(directory, 'feat/x', false)).rejects.toBeInstanceOf(GitError);
    expect(await currentBranch(directory)).toBe('main');
  });

  it('does not invent a local branch for a name it does not have', async () => {
    const directory = await repository();

    await expect(checkoutBranch(directory, 'nope', false)).rejects.toBeInstanceOf(GitError);
  });
});

describe('parseWorktreePorcelain', () => {
  it('reads branch, detached, bare, locked and prunable records', () => {
    const stdout = [
      'worktree /repo/.bare',
      'bare',
      '',
      'worktree /repo/main',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /repo/detached',
      'HEAD 2222222222222222222222222222222222222222',
      'detached',
      '',
      'worktree /repo/locked',
      'HEAD 3333333333333333333333333333333333333333',
      'branch refs/heads/feat/locked',
      'locked reason here',
      '',
      'worktree /repo/gone',
      'HEAD 4444444444444444444444444444444444444444',
      'branch refs/heads/feat/gone',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');

    expect(parseWorktreePorcelain(stdout)).toEqual([
      { path: '/repo/.bare', bare: true },
      { path: '/repo/main', branch: 'main' },
      { path: '/repo/detached' },
      { path: '/repo/locked', branch: 'feat/locked' },
      { path: '/repo/gone', branch: 'feat/gone', prunable: true },
    ]);
  });

  it('keeps a last record that has no trailing blank line', () => {
    expect(parseWorktreePorcelain('worktree /repo/main\nbranch refs/heads/main')).toEqual([
      { path: '/repo/main', branch: 'main' },
    ]);
  });
});

describe('branchCheckouts', () => {
  it('maps every branch held by another worktree, leaving out the folder asked about', async () => {
    const directory = await repository();
    const held = join(directory, '.wt', 'held');
    const detached = join(directory, '.wt', 'detached');
    await git(directory, ['worktree', 'add', '--quiet', '-b', 'feat/held', held]);
    await git(directory, ['worktree', 'add', '--quiet', '--detach', detached]);

    expect(await branchCheckouts(directory)).toEqual({ 'feat/held': { path: held } });
  });

  it('names the main checkout when asked from a worktree', async () => {
    const directory = await repository();
    const held = join(directory, '.wt', 'held');
    await git(directory, ['worktree', 'add', '--quiet', '-b', 'feat/held', held]);

    expect(await branchCheckouts(held)).toEqual({ main: { path: directory } });
  });

  it('keeps a worktree whose folder is gone, flagged, since git still holds its branch', async () => {
    const directory = await repository();
    const gone = join(directory, '.wt', 'gone');
    await git(directory, ['worktree', 'add', '--quiet', '-b', 'feat/gone', gone]);
    await rm(gone, { recursive: true, force: true });

    expect(await branchCheckouts(directory)).toEqual({ 'feat/gone': { path: gone, prunable: true } });
  });
});

describe('readable git errors', () => {
  it('drops the fatal: tag and hint lines, keeping what git said', () => {
    expect(
      readableGitMessage("fatal: 'feat/x' is already checked out at '/w/feat-x'\nhint: use 'git worktree prune'\n")
    ).toBe("'feat/x' is already checked out at '/w/feat-x'");
    expect(readableGitMessage('error: Your local changes would be overwritten\nAborting\n')).toBe(
      'Your local changes would be overwritten Aborting'
    );
  });

  it('carries no fatal: tag on a GitError from a real refusal', async () => {
    const directory = await repository();

    const refusal = await checkoutBranch(directory, 'nope', false).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(GitError);
    expect((refusal as GitError).message).not.toMatch(/^fatal:/i);
    expect((refusal as GitError).message).toMatch(/nope/);
  });
});

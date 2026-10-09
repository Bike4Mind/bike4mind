import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkoutBranch, currentBranch, git, GitError, uncommittedChanges } from './git';

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

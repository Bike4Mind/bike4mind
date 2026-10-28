import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatProject } from '@shared/chat';
import { git } from './git';
import { appWorktreeRoot, listAppWorktrees } from './workspace';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function repo() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'b4m-orphans-')));
  roots.push(directory);
  await git(directory, ['init', '-q', '--initial-branch=main']);
  await git(directory, ['config', 'user.email', 'test@example.com']);
  await git(directory, ['config', 'user.name', 'Test']);
  await writeFile(join(directory, '.gitignore'), '.b4m/\n');
  await git(directory, ['add', '.gitignore']);
  await git(directory, ['commit', '-qm', 'initial']);
  await mkdir(appWorktreeRoot(directory), { recursive: true });
  return directory;
}

async function addWorktree(directory: string, name: string, branch = `b4m/${name}-abc123`) {
  const path = join(appWorktreeRoot(directory), name);
  await git(directory, ['worktree', 'add', '-qb', branch, path]);
  return { path, branch };
}

function projectFor(directory: string, workingDirectory: string, extra: Partial<ChatProject> = {}): ChatProject {
  return {
    directory,
    name: 'owner',
    branch: 'main',
    workspace: true,
    workingDirectory,
    contextDirectories: [],
    ...extra,
  };
}

const byName = <T extends { path: string }>(items: T[], name: string) =>
  items.find(item => item.path.endsWith(`/${name}`));

describe('listAppWorktrees', () => {
  it('classifies clean, dirty and unpushed checkouts', async () => {
    const directory = await repo();
    const clean = await addWorktree(directory, 'clean');
    const dirty = await addWorktree(directory, 'dirty');
    const unpushed = await addWorktree(directory, 'unpushed');
    await writeFile(join(dirty.path, 'new.txt'), 'work\n');
    await writeFile(join(unpushed.path, 'a.txt'), 'a\n');
    await git(unpushed.path, ['add', 'a.txt']);
    await git(unpushed.path, ['commit', '-qm', 'local only']);

    const listed = await listAppWorktrees(directory, []);
    expect(listed).toHaveLength(3);
    expect(byName(listed, 'clean')).toMatchObject({ branch: clean.branch, safe: true, state: 'clean', owner: null });
    expect(byName(listed, 'clean')?.preservedRef).toBeTruthy();
    expect(byName(listed, 'clean')?.lastCommit).toMatch(/^\d{4}-/);
    expect(byName(listed, 'dirty')).toMatchObject({ safe: false, state: 'dirty', reason: '1 uncommitted file' });
    expect(byName(listed, 'unpushed')).toMatchObject({
      safe: false,
      state: 'unpushed',
      reason: '1 commit not pushed or merged',
    });
  });

  it('reports the owning project, including archived and shared local children', async () => {
    const directory = await repo();
    const direct = await addWorktree(directory, 'direct');
    const child = await addWorktree(directory, 'child');
    const nested = join(child.path, 'nested');
    await mkdir(nested);
    const owners = [
      projectFor(directory, direct.path, { name: 'archived', workspaceBranch: direct.branch }),
      projectFor(nested, nested, { name: 'local-child' }),
    ];
    const listed = await listAppWorktrees(directory, owners);
    expect(byName(listed, 'direct')).toMatchObject({ safe: false, state: 'owned', owner: 'archived' });
    expect(byName(listed, 'child')).toMatchObject({ safe: false, state: 'owned', owner: 'local-child' });
  });

  it('never lists a worktree outside the app root, and marks a foreign branch unsafe', async () => {
    const directory = await repo();
    const outside = `${directory}-elsewhere`;
    roots.push(outside);
    await git(directory, ['worktree', 'add', '-qb', 'b4m/outside-abc123', outside]);
    await addWorktree(directory, 'manual', 'feature/manual');
    const listed = await listAppWorktrees(directory, []);
    expect(listed.map(item => item.path)).toEqual([expect.stringMatching(/manual$/)]);
    expect(listed[0]).toMatchObject({ safe: false, state: 'foreign' });
  });

  it('prunes a hand-deleted folder', async () => {
    const directory = await repo();
    const gone = await addWorktree(directory, 'gone');
    await addWorktree(directory, 'kept');
    await rm(gone.path, { recursive: true, force: true });
    const listed = await listAppWorktrees(directory, []);
    expect(listed.map(item => item.path.split('/').pop())).toEqual(['kept']);
    expect((await git(directory, ['worktree', 'list', '--porcelain'])).includes('gone')).toBe(false);
  });
});

import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatProject } from '@shared/chat';
import * as repositoryGit from './git';
import {
  appWorktreeRoot,
  inspectWorktreeRemoval,
  listAppWorktrees,
  removeOrphanWorktree,
  removeSessionWorktree,
  sweepSafeOrphans,
} from './workspace';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'b4m-worktree-safety-')));
  roots.push(directory);
  await repositoryGit.git(directory, ['init', '-q', '--initial-branch=main']);
  await repositoryGit.git(directory, ['config', 'user.email', 'test@example.com']);
  await repositoryGit.git(directory, ['config', 'user.name', 'Test']);
  await writeFile(join(directory, '.gitignore'), '.b4m/\n.env\n');
  await repositoryGit.git(directory, ['add', '.gitignore']);
  await repositoryGit.git(directory, ['commit', '-qm', 'initial']);
  await mkdir(appWorktreeRoot(directory), { recursive: true });
  return directory;
}

async function addWorktree(directory: string, name: string) {
  const branch = `b4m/${name}-abc123`;
  const path = join(appWorktreeRoot(directory), name);
  await repositoryGit.git(directory, ['worktree', 'add', '-qb', branch, path]);
  const project: ChatProject = {
    directory,
    name,
    branch: 'main',
    workspace: true,
    workspaceBranch: branch,
    workingDirectory: path,
    contextDirectories: [],
  };
  return { path, branch, project };
}

describe('worktree cleanup safety', () => {
  it('keeps ignored local data in both orphan and conversation removal', async () => {
    const directory = await fixture();
    const worktree = await addWorktree(directory, 'ignored');
    const environmentFile = join(worktree.path, '.env');
    await writeFile(environmentFile, 'SECRET=local-only\n');

    expect((await listAppWorktrees(directory, []))[0]).toMatchObject({ safe: false, state: 'dirty' });
    expect(await removeOrphanWorktree(directory, worktree.path, [])).toMatchObject({ status: 'skipped' });
    await expect(removeSessionWorktree(worktree.project, [])).rejects.toThrow('uncommitted');
    expect(await readFile(environmentFile, 'utf8')).toBe('SECRET=local-only\n');
  });

  it('removes a worktree whose only ignored content is an installed node_modules', async () => {
    const directory = await fixture();
    await writeFile(join(directory, '.gitignore'), '.b4m/\n.env\nnode_modules/\n');
    await repositoryGit.git(directory, ['commit', '-qam', 'ignore modules']);
    const worktree = await addWorktree(directory, 'installed');
    await mkdir(join(worktree.path, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(worktree.path, 'node_modules', 'dep', 'index.js'), '');

    expect((await listAppWorktrees(directory, []))[0]).toMatchObject({ safe: true, state: 'clean' });
    expect(await removeOrphanWorktree(directory, worktree.path, [])).toMatchObject({ status: 'removed' });
    await expect(stat(worktree.path)).rejects.toThrow();
  });

  it('still keeps a worktree that holds node_modules next to an ignored .env', async () => {
    const directory = await fixture();
    await writeFile(join(directory, '.gitignore'), '.b4m/\n.env\nnode_modules/\n');
    await repositoryGit.git(directory, ['commit', '-qam', 'ignore modules']);
    const worktree = await addWorktree(directory, 'mixed');
    await mkdir(join(worktree.path, 'node_modules'), { recursive: true });
    await writeFile(join(worktree.path, 'node_modules', 'x'), '');
    await writeFile(join(worktree.path, '.env'), 'SECRET=1\n');

    expect((await listAppWorktrees(directory, []))[0]).toMatchObject({ safe: false, reason: '1 uncommitted file' });
  });

  it('protects a worktree used only as another project context directory', async () => {
    const directory = await fixture();
    const worktree = await addWorktree(directory, 'context');
    const owner: ChatProject = {
      ...worktree.project,
      workspaceBranch: undefined,
      workingDirectory: directory,
      contextDirectories: [worktree.path],
    };

    expect((await listAppWorktrees(directory, [owner]))[0]).toMatchObject({ safe: false, state: 'owned' });
    expect(await inspectWorktreeRemoval(worktree.project, [owner])).toMatchObject({ safe: false });
    expect(await removeOrphanWorktree(directory, worktree.path, [owner])).toMatchObject({ status: 'skipped' });
    expect((await stat(worktree.path)).isDirectory()).toBe(true);
  });

  it('protects grant-only conversations and displays their owner name', async () => {
    const directory = await fixture();
    const worktree = await addWorktree(directory, 'grant');
    const options = { owners: [{ directories: [worktree.path], title: 'Reference checkout' }] };

    expect((await listAppWorktrees(directory, [], options))[0]).toMatchObject({
      safe: false,
      state: 'owned',
      owner: 'Reference checkout',
    });
    expect(await removeOrphanWorktree(directory, worktree.path, [], options)).toMatchObject({ status: 'skipped' });
    await expect(removeSessionWorktree(worktree.project, [], options)).rejects.toThrow('another conversation');
    expect((await stat(worktree.path)).isDirectory()).toBe(true);
  });

  it.each(['orphan', 'conversation'] as const)('rechecks preparation after async %s inspection', async removal => {
    const directory = await fixture();
    const worktree = await addWorktree(directory, removal);
    let preparing = false;
    const originalGit = repositoryGit.git;
    vi.spyOn(repositoryGit, 'git').mockImplementation(async (path, args) => {
      const result = await originalGit(path, args);
      if (args[0] === 'rev-list') preparing = true;
      return result;
    });
    const options = { hold: () => (preparing ? 'A workspace is being prepared' : null) };

    if (removal === 'orphan') {
      expect(await removeOrphanWorktree(directory, worktree.path, [], options)).toMatchObject({
        status: 'skipped',
        message: 'A workspace is being prepared',
      });
    } else {
      await expect(removeSessionWorktree(worktree.project, [], options)).rejects.toThrow('being prepared');
    }
    expect((await stat(worktree.path)).isDirectory()).toBe(true);
  });

  it('continues a sweep past an unreadable checkout and reports every path', async () => {
    const directory = await fixture();
    const broken = await addWorktree(directory, 'a-broken');
    const clean = await addWorktree(directory, 'z-clean');
    await writeFile(join(broken.path, '.git'), 'gitdir: /nonexistent/b4m-test-gitdir\n');

    const results = await sweepSafeOrphans(directory, []);
    expect(results).toHaveLength(2);
    expect(results.find(item => item.path === broken.path)).toMatchObject({ status: 'skipped' });
    expect(results.find(item => item.path === broken.path)?.message).toContain('Could not inspect worktree');
    expect(results.find(item => item.path === clean.path)).toMatchObject({ status: 'removed' });
    expect((await stat(broken.path)).isDirectory()).toBe(true);
    await expect(stat(clean.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await removeOrphanWorktree(directory, broken.path, [])).toMatchObject({ status: 'failed' });
  });

  it('retains earlier results and continues when reinspection fails during a sweep', async () => {
    const directory = await fixture();
    const first = await addWorktree(directory, 'a-first');
    const failing = await addWorktree(directory, 'b-failing');
    const last = await addWorktree(directory, 'c-last');
    const originalGit = repositoryGit.git;
    let inspections = 0;
    vi.spyOn(repositoryGit, 'git').mockImplementation(async (path, args) => {
      if (path === failing.path && args[0] === 'status' && ++inspections === 2) {
        throw new Error('Could not read checkout status');
      }
      return originalGit(path, args);
    });

    const results = await sweepSafeOrphans(directory, []);
    expect(results).toEqual([
      { path: first.path, branch: first.branch, status: 'removed', message: null },
      { path: failing.path, branch: failing.branch, status: 'failed', message: 'Could not read checkout status' },
      { path: last.path, branch: last.branch, status: 'removed', message: null },
    ]);
    expect((await stat(failing.path)).isDirectory()).toBe(true);
  });
});

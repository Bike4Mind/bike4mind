import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatProject } from '@shared/chat';
import { ChatService } from '../ChatService';
import { SessionStore } from '../SessionStore';
import type { AccessStore } from '../tools/AccessStore';
import * as repositoryGit from './git';
import { gitFixture } from './gitFixture.testHelper';
import {
  appWorktreeRoot,
  listAppWorktrees,
  removeOrphanWorktree,
  removeSessionWorktree,
  sweepSafeOrphans,
} from './workspace';

const { git } = repositoryGit;

const roots: string[] = [];
const services: ChatService[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  services.splice(0).forEach(service => service.dispose());
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const repository = gitFixture(
  'b4m-orphans-',
  async directory => {
    await git(directory, ['init', '-q', '--initial-branch=main']);
    await git(directory, ['config', 'user.email', 'test@example.com']);
    await git(directory, ['config', 'user.name', 'Test']);
    await writeFile(join(directory, '.gitignore'), '.b4m/\n.env\nnode_modules/\n');
    await git(directory, ['add', '.gitignore']);
    await git(directory, ['commit', '-qm', 'initial']);
    await mkdir(appWorktreeRoot(directory), { recursive: true });
  },
  []
);

// Built here so the one-time cost is not charged to whichever test happens to run first.
beforeAll(async () => {
  roots.push(await repository());
});

async function repo() {
  const directory = await repository();
  roots.push(directory);
  return directory;
}

async function addWorktree(directory: string, name: string, branch = `b4m/${name}-abc123`) {
  const path = join(appWorktreeRoot(directory), name);
  await git(directory, ['worktree', 'add', '-qb', branch, path]);
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

const byName = <T extends { path: string }>(items: T[], name: string) =>
  items.find(item => item.path.endsWith(`/${name}`));

const branchExists = (directory: string, branch: string) =>
  git(directory, ['show-ref', '--verify', `refs/heads/${branch}`]).then(
    () => true,
    () => false
  );

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

  it('holds every checkout while a workspace is being prepared', async () => {
    const directory = await repo();
    await addWorktree(directory, 'fresh');
    const listed = await listAppWorktrees(directory, [], { hold: () => 'A workspace is being prepared' });
    expect(listed[0]).toMatchObject({ safe: false, reason: 'A workspace is being prepared' });
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

  it('does not list a hand-deleted folder and leaves the registry alone', async () => {
    const directory = await repo();
    const gone = await addWorktree(directory, 'gone');
    await addWorktree(directory, 'kept');
    await rm(gone.path, { recursive: true, force: true });
    const listed = await listAppWorktrees(directory, []);
    expect(listed.map(item => item.path.split('/').pop())).toEqual(['kept']);
    expect((await git(directory, ['worktree', 'list', '--porcelain'])).includes('gone')).toBe(true);
  });
});

describe('worktree cleanup safety', () => {
  // `git worktree remove` deletes ignored files too, so ignored local data must keep the checkout.
  it('keeps a checkout holding ignored local data', async () => {
    const directory = await repo();
    const worktree = await addWorktree(directory, 'ignored');
    const environmentFile = join(worktree.path, '.env');
    await writeFile(environmentFile, 'SECRET=local-only\n');

    expect(await removeOrphanWorktree(directory, worktree.path, [])).toMatchObject({
      status: 'skipped',
      message: '1 uncommitted file',
    });
    expect(await readFile(environmentFile, 'utf8')).toBe('SECRET=local-only\n');
  });

  it('removes a checkout whose only ignored content is node_modules, but not one with a .env beside it', async () => {
    const directory = await repo();
    const installed = await addWorktree(directory, 'installed');
    await mkdir(join(installed.path, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(installed.path, 'node_modules', 'dep', 'index.js'), '');
    const mixed = await addWorktree(directory, 'mixed');
    await mkdir(join(mixed.path, 'node_modules'), { recursive: true });
    await writeFile(join(mixed.path, 'node_modules', 'x'), '');
    await writeFile(join(mixed.path, '.env'), 'SECRET=1\n');

    const listed = await listAppWorktrees(directory, []);
    expect(byName(listed, 'installed')).toMatchObject({ safe: true, state: 'clean' });
    expect(byName(listed, 'mixed')).toMatchObject({ safe: false, reason: '1 uncommitted file' });
    expect(await removeOrphanWorktree(directory, installed.path, [])).toMatchObject({ status: 'removed' });
    await expect(stat(installed.path)).rejects.toThrow();
  });

  it.each(['orphan', 'conversation'] as const)('rechecks preparation after async %s inspection', async removal => {
    const directory = await repo();
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

  // A failed removal must not end the sweep: the checkout after it is still reported.
  it('continues a sweep past a removal that fails, and reports a checkout it cannot inspect', async () => {
    const directory = await repo();
    const failing = await addWorktree(directory, 'a-failing');
    const broken = await addWorktree(directory, 'b-broken');
    await writeFile(join(broken.path, '.git'), 'gitdir: /nonexistent/b4m-test-gitdir\n');
    const originalGit = repositoryGit.git;
    let inspections = 0;
    vi.spyOn(repositoryGit, 'git').mockImplementation(async (path, args) => {
      if (path === failing.path && args[0] === 'status' && ++inspections === 2) {
        throw new Error('Could not read checkout status');
      }
      return originalGit(path, args);
    });

    const results = await sweepSafeOrphans(directory, []);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      path: failing.path,
      branch: failing.branch,
      status: 'failed',
      message: 'Could not read checkout status',
    });
    expect(results[1]).toMatchObject({ path: broken.path, status: 'skipped' });
    expect(results[1].message).toContain('Could not inspect worktree');
    expect((await stat(broken.path)).isDirectory()).toBe(true);
    expect((await stat(failing.path)).isDirectory()).toBe(true);
  });

  it('retains earlier results and continues when reinspection fails during a sweep', async () => {
    const directory = await repo();
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

describe('orphan worktree removal through the service', () => {
  async function serviceFixture() {
    const directory = await repo();
    const sessions = join(directory, '.b4m', 'sessions');
    await mkdir(sessions, { recursive: true });
    const store = new SessionStore(sessions, 'test-model');
    const service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => null,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: () => {},
    });
    services.push(service);
    return { directory, store, service };
  }

  it('sweeps a clean orphan and its branch when no paths are named', async () => {
    const { directory, service } = await serviceFixture();
    const clean = await addWorktree(directory, 'clean');
    const results = await service.removeWorktrees(directory);
    expect(results).toEqual([{ path: clean.path, branch: clean.branch, status: 'removed', message: null }]);
    await expect(stat(clean.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await branchExists(directory, clean.branch)).toBe(false);
  });

  it('surfaces a branch that could not be deleted after the checkout was removed', async () => {
    const { directory, service } = await serviceFixture();
    const clean = await addWorktree(directory, 'clean');
    await mkdir(join(directory, '.git', 'refs', 'heads', 'b4m'), { recursive: true });
    await writeFile(join(directory, '.git', 'refs', 'heads', `${clean.branch}.lock`), '');
    const [result] = await service.removeWorktrees(directory, [clean.path]);
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.message).toContain(`branch ${clean.branch} was kept`);
  });

  it('skips a checkout that became owned by a conversation after it was listed', async () => {
    const { directory, store, service } = await serviceFixture();
    const orphan = await addWorktree(directory, 'orphan');
    expect((await service.listWorktrees(directory))[0]).toMatchObject({ safe: true, owner: null });
    await store.create(undefined, { project: { ...orphan.project, name: 'owner' }, mode: 'code' });
    const [result] = await service.removeWorktrees(directory, [orphan.path]);
    expect(result).toMatchObject({ status: 'skipped', message: 'Used by another conversation' });
    expect((await stat(orphan.path)).isDirectory()).toBe(true);
    expect(await branchExists(directory, orphan.branch)).toBe(true);
  });

  it.each(['grant-only', 'context-only'] as const)(
    'preserves a %s conversation reference and names it as the owner',
    async kind => {
      const { directory, store, service } = await serviceFixture();
      const checkout = await addWorktree(directory, 'shared');
      const title = `Shared ${kind} checkout`;
      await store.create(undefined, {
        title,
        ...(kind === 'grant-only'
          ? { grantedDirectories: [checkout.path] }
          : {
              project: {
                directory,
                name: 'other project',
                branch: 'main',
                workspace: false,
                workingDirectory: directory,
                contextDirectories: [checkout.path],
              },
            }),
      });

      expect((await service.listWorktrees(directory))[0]).toMatchObject({
        path: checkout.path,
        safe: false,
        state: 'owned',
        owner: title,
      });
      expect((await service.removeWorktrees(directory, [checkout.path]))[0]).toMatchObject({
        status: 'skipped',
        message: 'Used by another conversation',
      });
      expect((await stat(checkout.path)).isDirectory()).toBe(true);
      expect(await branchExists(directory, checkout.branch)).toBe(true);
    }
  );

  it('preserves a grant-only owner when deleting the checkout conversation', async () => {
    const { directory, store, service } = await serviceFixture();
    const checkout = await addWorktree(directory, 'shared');
    const owningSession = await store.create(undefined, { project: checkout.project });
    await store.create(undefined, { title: 'Reference checkout', grantedDirectories: [checkout.path] });

    expect(await service.inspectSessionWorktreeRemoval(owningSession.id)).toMatchObject({
      safe: false,
      reason: 'Used by another conversation',
    });
    await expect(service.deleteSession(owningSession.id, true)).rejects.toThrow('Used by another conversation');
    expect(await store.get(owningSession.id)).not.toBeNull();
    expect((await stat(checkout.path)).isDirectory()).toBe(true);
    expect(await branchExists(directory, checkout.branch)).toBe(true);
  });

  it('skips a path that is not a listed worktree', async () => {
    const { directory, service } = await serviceFixture();
    const [result] = await service.removeWorktrees(directory, [directory]);
    expect(result).toMatchObject({ status: 'skipped', message: 'No longer listed' });
    expect((await stat(directory)).isDirectory()).toBe(true);
  });

  it('reveals only a currently listed worktree', async () => {
    const { directory, service } = await serviceFixture();
    const listed = await addWorktree(directory, 'listed');
    const reveal = vi.fn();
    expect(await service.revealWorktree(directory, '/etc', reveal)).toBe(false);
    expect(reveal).not.toHaveBeenCalled();
    expect(await service.revealWorktree(directory, listed.path, reveal)).toBe(true);
    expect(reveal).toHaveBeenCalledWith(listed.path);
  });
});

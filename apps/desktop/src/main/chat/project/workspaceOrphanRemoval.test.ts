import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatProject } from '@shared/chat';
import { ChatService } from '../ChatService';
import { SessionStore } from '../SessionStore';
import type { AccessStore } from '../tools/AccessStore';
import { git } from './git';
import { appWorktreeRoot } from './workspace';

const roots: string[] = [];
const services: ChatService[] = [];
afterEach(async () => {
  services.splice(0).forEach(service => service.dispose());
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'b4m-orphan-rm-')));
  roots.push(directory);
  await git(directory, ['init', '-q', '--initial-branch=main']);
  await git(directory, ['config', 'user.email', 'test@example.com']);
  await git(directory, ['config', 'user.name', 'Test']);
  await writeFile(join(directory, '.gitignore'), '.b4m/\n');
  await git(directory, ['add', '.gitignore']);
  await git(directory, ['commit', '-qm', 'initial']);
  await mkdir(appWorktreeRoot(directory), { recursive: true });
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

async function addWorktree(directory: string, name: string) {
  const branch = `b4m/${name}-abc123`;
  const path = join(appWorktreeRoot(directory), name);
  await git(directory, ['worktree', 'add', '-qb', branch, path]);
  return { path, branch };
}

const branchExists = (directory: string, branch: string) =>
  git(directory, ['show-ref', '--verify', `refs/heads/${branch}`]).then(
    () => true,
    () => false
  );

describe('orphan worktree removal', () => {
  it('removes one clean orphan and its branch', async () => {
    const { directory, service } = await fixture();
    const clean = await addWorktree(directory, 'clean');
    const results = await service.removeWorktrees(directory, [clean.path]);
    expect(results).toEqual([{ path: clean.path, branch: clean.branch, status: 'removed', message: null }]);
    await expect(stat(clean.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await branchExists(directory, clean.branch)).toBe(false);
  });

  it('removes every safe orphan and skips dirty and unpushed ones with their reason', async () => {
    const { directory, service } = await fixture();
    const clean = await addWorktree(directory, 'clean');
    const dirty = await addWorktree(directory, 'dirty');
    const unpushed = await addWorktree(directory, 'unpushed');
    await writeFile(join(dirty.path, 'new.txt'), 'work\n');
    await writeFile(join(unpushed.path, 'a.txt'), 'a\n');
    await git(unpushed.path, ['add', 'a.txt']);
    await git(unpushed.path, ['commit', '-qm', 'local only']);

    const results = await service.removeWorktrees(directory);
    const status = (path: string) => results.find(item => item.path === path);
    expect(status(clean.path)?.status).toBe('removed');
    expect(status(dirty.path)).toMatchObject({ status: 'skipped', message: '1 uncommitted file' });
    expect(status(unpushed.path)).toMatchObject({ status: 'skipped', message: '1 commit not pushed or merged' });
    await expect(stat(clean.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(dirty.path)).isDirectory()).toBe(true);
    expect(await branchExists(directory, dirty.branch)).toBe(true);
    expect(await branchExists(directory, unpushed.branch)).toBe(true);
  });

  it('surfaces a branch that could not be deleted after the checkout was removed', async () => {
    const { directory, service } = await fixture();
    const clean = await addWorktree(directory, 'clean');
    await mkdir(join(directory, '.git', 'refs', 'heads', 'b4m'), { recursive: true });
    await writeFile(join(directory, '.git', 'refs', 'heads', `${clean.branch}.lock`), '');
    const [result] = await service.removeWorktrees(directory, [clean.path]);
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.message).toContain(`branch ${clean.branch} was kept`);
  });

  it('skips a checkout that became owned by a conversation after it was listed', async () => {
    const { directory, store, service } = await fixture();
    const orphan = await addWorktree(directory, 'orphan');
    expect((await service.listWorktrees(directory))[0]).toMatchObject({ safe: true, owner: null });
    const project: ChatProject = {
      directory,
      name: 'owner',
      branch: 'main',
      workspace: true,
      workspaceBranch: orphan.branch,
      workingDirectory: orphan.path,
      contextDirectories: [],
    };
    await store.create(undefined, { project, mode: 'code' });
    const [result] = await service.removeWorktrees(directory, [orphan.path]);
    expect(result).toMatchObject({ status: 'skipped', message: 'Used by another conversation' });
    expect((await stat(orphan.path)).isDirectory()).toBe(true);
    expect(await branchExists(directory, orphan.branch)).toBe(true);
  });

  it.each(['grant-only', 'context-only'] as const)(
    'preserves a %s conversation reference through the service',
    async kind => {
      const { directory, store, service } = await fixture();
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
    const { directory, store, service } = await fixture();
    const checkout = await addWorktree(directory, 'shared');
    const owningSession = await store.create(undefined, {
      project: {
        directory,
        name: 'checkout owner',
        branch: 'main',
        workspace: true,
        workspaceBranch: checkout.branch,
        workingDirectory: checkout.path,
        contextDirectories: [],
      },
    });
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
    const { directory, service } = await fixture();
    const [result] = await service.removeWorktrees(directory, [directory]);
    expect(result).toMatchObject({ status: 'skipped', message: 'No longer listed' });
    expect((await stat(directory)).isDirectory()).toBe(true);
  });

  it('reveals only a currently listed worktree', async () => {
    const { directory, service } = await fixture();
    const listed = await addWorktree(directory, 'listed');
    const reveal = vi.fn();
    expect(await service.revealWorktree(directory, directory, reveal)).toBe(false);
    expect(await service.revealWorktree(directory, '/etc', reveal)).toBe(false);
    expect(reveal).not.toHaveBeenCalled();
    expect(await service.revealWorktree(directory, listed.path, reveal)).toBe(true);
    expect(reveal).toHaveBeenCalledWith(listed.path);
  });
});

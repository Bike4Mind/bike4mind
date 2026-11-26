import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatProject, ChatSession } from '@shared/chat';
import { projectFor } from '../../claudeImport/ClaudeCodeSync';
import { ChatService } from '../ChatService';
import { SessionStore } from '../SessionStore';
import type { AccessStore } from '../tools/AccessStore';
import { git, listWorktrees } from './git';
import { gitFixture } from './gitFixture.testHelper';
import { appWorktreeRoot, inspectWorktreeRemoval, removeSessionWorktree } from './workspace';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const BRANCH = 'b4m/test-123abc';
const repository = gitFixture(
  'b4m-removal-',
  async directory => {
    await git(directory, ['init', '-q', '--initial-branch=main']);
    await git(directory, ['config', 'user.email', 'test@example.com']);
    await git(directory, ['config', 'user.name', 'Test']);
    await writeFile(join(directory, '.gitignore'), '.b4m/\nignored\n');
    await git(directory, ['add', '.gitignore']);
    await git(directory, ['commit', '-qm', 'initial']);
    await mkdir(appWorktreeRoot(directory), { recursive: true });
    await git(directory, ['worktree', 'add', '-qb', BRANCH, join(appWorktreeRoot(directory), 'test')]);
  },
  ['.git/worktrees/test/gitdir', '.b4m/worktrees/test/.git']
);

// Built here so the one-time cost is not charged to whichever test happens to run first.
beforeAll(async () => {
  roots.push(await repository());
});

async function fixture() {
  const directory = await repository();
  roots.push(directory);
  const branch = BRANCH;
  const workingDirectory = join(appWorktreeRoot(directory), 'test');
  const project: ChatProject = {
    directory,
    name: 'test',
    branch: 'main',
    workspace: true,
    workspaceBranch: branch,
    workingDirectory,
    contextDirectories: [],
  };
  return project;
}

describe('session worktree removal', () => {
  it('removes a clean merged checkout and its branch', async () => {
    const project = await fixture();
    expect(await inspectWorktreeRemoval(project, [])).toMatchObject({ safe: true, reason: null });
    await removeSessionWorktree(project, []);
    await expect(stat(project.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await listWorktrees(project.directory)).map(entry => entry.path)).not.toContain(project.workingDirectory);
    await expect(
      git(project.directory, ['show-ref', '--verify', `refs/heads/${project.workspaceBranch}`])
    ).rejects.toThrow();
  });

  // Untracked rather than modified: a modified file shows in any status, an untracked one only with the flag.
  it('discards uncommitted changes, including changes after inspection, and keeps the branch', async () => {
    const project = await fixture();
    expect((await inspectWorktreeRemoval(project, []))?.safe).toBe(true);
    await writeFile(join(project.workingDirectory, 'new.txt'), 'work\n');
    expect(await inspectWorktreeRemoval(project, [])).toMatchObject({
      safe: false,
      removable: true,
      reason: `1 uncommitted file will be discarded; branch ${project.workspaceBranch} is kept`,
    });
    await removeSessionWorktree(project, [], { allowDiscard: true });
    await expect(stat(project.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await git(project.directory, ['show-ref', '--verify', `refs/heads/${project.workspaceBranch}`]);
  });

  it('removes the checkout but keeps a branch with local commits absent from the base and upstream', async () => {
    const project = await fixture();
    await git(project.workingDirectory, ['commit', '--allow-empty', '-qm', 'local']);
    const tip = (await git(project.directory, ['rev-parse', `refs/heads/${project.workspaceBranch}`])).trim();
    expect(await inspectWorktreeRemoval(project, [])).toMatchObject({
      safe: false,
      removable: true,
      reason: `Branch ${project.workspaceBranch} is kept: 1 commit not pushed or merged`,
    });
    await removeSessionWorktree(project, [], { allowDiscard: true });
    await expect(stat(project.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await git(project.directory, ['rev-parse', `refs/heads/${project.workspaceBranch}`])).trim()).toBe(tip);
  });

  it('accepts commits preserved in the configured upstream', async () => {
    const project = await fixture();
    await git(project.workingDirectory, ['commit', '--allow-empty', '-qm', 'pushed']);
    await git(project.directory, ['update-ref', 'refs/remotes/origin/pushed', project.workspaceBranch!]);
    await git(project.directory, ['config', 'remote.origin.url', project.directory]);
    await git(project.directory, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    await git(project.directory, ['branch', '--set-upstream-to=origin/pushed', project.workspaceBranch!]);
    await removeSessionWorktree(project, []);
    await expect(stat(project.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recognizes a remote base ahead of its local branch', async () => {
    const project = await fixture();
    await git(project.workingDirectory, ['commit', '--allow-empty', '-qm', 'remote base']);
    await git(project.directory, ['update-ref', 'refs/remotes/origin/main', project.workspaceBranch!]);
    expect(await inspectWorktreeRemoval(project, [])).toMatchObject({ safe: true });
    await removeSessionWorktree(project, []);
    await expect(stat(project.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      git(project.directory, ['show-ref', '--verify', `refs/heads/${project.workspaceBranch}`])
    ).rejects.toThrow();
  });

  it('refuses before removing anything when the base, but not the upstream Git checks, has the commits', async () => {
    const project = await fixture();
    await git(project.directory, ['update-ref', 'refs/remotes/origin/pushed', 'main']);
    await git(project.directory, ['config', 'remote.origin.url', project.directory]);
    await git(project.directory, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    await git(project.directory, ['branch', '--set-upstream-to=origin/pushed', project.workspaceBranch!]);
    await git(project.workingDirectory, ['commit', '--allow-empty', '-qm', 'merged']);
    await git(project.directory, ['merge', '--ff-only', project.workspaceBranch!]);
    expect(await inspectWorktreeRemoval(project, [])).toMatchObject({ safe: false, removable: true });
    await removeSessionWorktree(project, [], { allowDiscard: true });
    await expect(stat(project.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await git(project.directory, ['show-ref', '--verify', `refs/heads/${project.workspaceBranch}`]);
    expect((await git(project.directory, ['config', '--get', `branch.${project.workspaceBranch}.merge`])).trim()).toBe(
      'refs/heads/pushed'
    );
  });

  it('counts ignored files among what removal discards', async () => {
    const project = await fixture();
    await writeFile(join(project.workingDirectory, 'ignored'), 'generated\n');
    expect(await inspectWorktreeRemoval(project, [])).toMatchObject({
      safe: false,
      removable: true,
      reason: expect.stringContaining('1 uncommitted file will be discarded'),
    });
    await removeSessionWorktree(project, [], { allowDiscard: true });
    await expect(stat(project.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps an ignored nested worktree and its uncommitted files', async () => {
    const project = await fixture();
    const nested = join(project.workingDirectory, 'ignored', 'child');
    await git(project.directory, ['worktree', 'add', '-qb', 'claude/child', nested]);
    const uncommitted = join(nested, 'uncommitted.txt');
    await writeFile(uncommitted, 'keep this work\n');
    expect(await git(project.workingDirectory, ['status', '--porcelain', '-z', '--untracked-files=all'])).toBe('');
    expect(await inspectWorktreeRemoval(project, [])).toMatchObject({ safe: false, removable: false });
    await expect(removeSessionWorktree(project, [])).rejects.toThrow();
    expect((await stat(uncommitted)).isFile()).toBe(true);
  });

  it('keeps folders used by a conversation rooted inside the checkout', async () => {
    const project = await fixture();
    const nested = join(project.workingDirectory, 'ignored');
    await mkdir(nested);
    const other = {
      ...project,
      directory: nested,
      workingDirectory: nested,
      branch: '',
      workspace: false,
      workspaceBranch: undefined,
    };
    expect(await inspectWorktreeRemoval(project, [other])).toMatchObject({
      safe: false,
      reason: 'Used by another conversation',
    });
    await expect(removeSessionWorktree(project, [other])).rejects.toThrow('another conversation');
    expect((await stat(nested)).isDirectory()).toBe(true);
  });

  it('refuses another conversation on the same branch elsewhere in the repository', async () => {
    const project = await fixture();
    const other = {
      ...project,
      workspace: false,
      workspaceBranch: undefined,
      branch: project.workspaceBranch!,
      workingDirectory: project.directory,
    };
    expect(await inspectWorktreeRemoval(project, [other])).toMatchObject({
      safe: false,
      reason: 'Used by another conversation',
    });
    await expect(removeSessionWorktree(project, [other])).rejects.toThrow('another conversation');
  });

  it('hides cleanup for user and imported checkouts or a mismatched branch', async () => {
    const project = await fixture();
    expect(await inspectWorktreeRemoval({ ...project, workingDirectory: project.directory }, [])).toBeNull();
    expect(await inspectWorktreeRemoval({ ...project, workspaceBranch: 'claude/imported' }, [])).toBeNull();
    expect(await inspectWorktreeRemoval({ ...project, workspaceBranch: 'b4m/other' }, [])).toBeNull();
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}

function importedSession(project?: ChatProject): ChatSession {
  const at = '2026-01-01T00:00:00.000Z';
  return {
    id: 'cc-workspace-binding',
    title: 'Imported conversation',
    model: 'test-model',
    createdAt: at,
    updatedAt: at,
    mode: 'code',
    approvalMode: 'ask',
    reasoningEffort: 'default',
    ...(project ? { project } : {}),
    importOrigin: { kind: 'claude-code', sourceId: 'binding', importedAt: at, sourceUpdatedAt: at },
    messages: [],
  };
}

async function staleImportProject(project: ChatProject): Promise<ChatProject> {
  const binding = await projectFor(
    join(project.workingDirectory, '.claude', 'worktrees', 'removed-child'),
    'claude/removed-child',
    async directory => {
      try {
        return (await stat(directory)).isDirectory();
      } catch {
        return false;
      }
    }
  );
  if (!binding) throw new Error('Expected the importer to fall back to the containing checkout');
  return binding;
}

async function serviceFixture(
  onRelease?: (store: SessionStore, project: ChatProject) => Promise<void>,
  terminalLease?: () => Promise<() => void>
) {
  const project = await fixture();
  const store = new SessionStore(join(project.directory, '.b4m', 'sessions'), 'test-model');
  const session = await store.create(undefined, { project, mode: 'code' });
  const releases: string[] = [];
  const service = new ChatService({
    store,
    access: { list: async () => [] } as unknown as AccessStore,
    logger: { debug: vi.fn(), warn: vi.fn() },
    getApiClient: () => null,
    getEnvironmentUrl: () => 'http://localhost:3000',
    emit: () => {},
    background: {
      list: () => [],
      killSession: async () => {
        if (!releases.includes('background')) expect((await stat(project.workingDirectory)).isDirectory()).toBe(true);
        releases.push('background');
        await onRelease?.(store, project);
      },
    } as unknown as import('../ChatService').ChatServiceDeps['background'],
    sessionClosed: () => {
      releases.push('terminal');
    },
    releaseSessionTerminals:
      terminalLease ??
      (async () => {
        releases.push('terminal-release');
        return () => {
          releases.push('terminal-unlock');
        };
      }),
  });
  return { project, store, session, service, releases };
}

describe('session deletion integration', () => {
  it('waits for an import binding already being written before checking sharing', async () => {
    const { project, store, session, service } = await serviceFixture();
    const imported = importedSession(await staleImportProject(project));
    const writing = deferred();
    const finishWrite = deferred();
    const writer = store as unknown as { write(directory: string, session: ChatSession): Promise<void> };
    const write = writer.write.bind(store);
    const writeSpy = vi.spyOn(writer, 'write').mockImplementation(async (directory, record) => {
      if (record.id === imported.id) {
        writing.resolve();
        await finishWrite.promise;
      }
      await write(directory, record);
    });
    try {
      const importing = store.putImported(imported);
      await writing.promise;
      const inspect = vi.spyOn(store, 'workspaceProjectsExcept');
      const deleting = expect(service.deleteSession(session.id, true)).rejects.toThrow('another conversation');
      await Promise.resolve();
      expect(inspect).not.toHaveBeenCalled();
      finishWrite.resolve();
      expect(await importing).toBe('written');
      await deleting;
      expect((await stat(project.workingDirectory)).isDirectory()).toBe(true);
      expect((await store.get(imported.id))?.project?.workingDirectory).toBe(project.workingDirectory);
    } finally {
      finishWrite.resolve();
      writeSpy.mockRestore();
      service.dispose();
    }
  });

  // 'sync' (mustExist) and a plain re-import of an existing row take the same path once the row exists.
  it.each(['new', 'sync'])('cancels a stale %s import binding queued behind cleanup', async kind => {
    const acquiring = deferred();
    const exited = deferred();
    const { project, store, session, service } = await serviceFixture(undefined, async () => {
      acquiring.resolve();
      await exited.promise;
      return () => {};
    });
    const imported = importedSession(await staleImportProject(project));
    if (kind !== 'new') expect(await store.putImported(importedSession())).toBe('written');
    try {
      const deleting = service.deleteSession(session.id, true);
      await acquiring.promise;
      const importing = store.putImported(imported, undefined, { mustExist: kind === 'sync' });
      exited.resolve();
      await deleting;
      expect(await importing).toBe('removed');
      const stored = await store.get(imported.id);
      if (kind === 'new') expect(stored).toBeNull();
      else expect(stored?.project).toBeUndefined();
      await expect(stat(project.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      exited.resolve();
      service.dispose();
    }
  });

  it('replaces a kept project whose checkout is gone with the incoming import project', async () => {
    const project = await fixture();
    const store = new SessionStore(join(project.directory, '.b4m', 'sessions'), 'test-model');
    const imported = importedSession(project);
    expect(await store.putImported(imported)).toBe('written');
    const kept = { ...project, workingDirectory: join(project.directory, 'removed-checkout') };
    await store.setProject(imported.id, kept);
    expect(await store.putImported(imported)).toBe('written');
    expect((await store.get(imported.id))?.project).toEqual(project);
  });

  it('cancels imports whose working directory has a non-directory ancestor', async () => {
    const project = await fixture();
    const store = new SessionStore(join(project.directory, '.b4m', 'sessions'), 'test-model');
    const imported = importedSession({ ...project, workingDirectory: join(project.directory, '.gitignore', 'child') });
    expect(await store.putImported(imported)).toBe('removed');
    expect(await store.get(imported.id)).toBeNull();
  });

  it('surfaces unexpected errors while checking imported workspace paths', async () => {
    const project = await fixture();
    const store = new SessionStore(join(project.directory, '.b4m', 'sessions'), 'test-model');
    const imported = importedSession({ ...project, workingDirectory: 'invalid\u0000path' });
    await expect(store.putImported(imported)).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' });
    expect(await store.get(imported.id)).toBeNull();
  });

  it('releases session resources before removing the checkout, then deletes the session', async () => {
    const { project, store, session, service, releases } = await serviceFixture();
    try {
      const remove = vi.spyOn(store, 'delete').mockImplementation(async () => {
        expect(releases).toContain('background');
        expect(releases).toContain('terminal');
        expect(releases).toContain('terminal-release');
        expect(releases).not.toContain('terminal-unlock');
        await expect(stat(project.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      });
      const expectedScope = store.scopeKey();
      await service.deleteSession(session.id, true);
      expect(remove).toHaveBeenCalledWith(session.id, expectedScope);
      expect(releases).toContain('terminal-unlock');
    } finally {
      service.dispose();
    }
  });

  it('waits for terminal exit and keeps its lease until checkout removal completes', async () => {
    const acquiring = deferred();
    const exited = deferred();
    const unlock = vi.fn();
    const { project, store, session, service, releases } = await serviceFixture(undefined, async () => {
      acquiring.resolve();
      await exited.promise;
      return unlock;
    });
    try {
      const deleting = service.deleteSession(session.id, true);
      await acquiring.promise;
      expect(releases).not.toContain('terminal');
      expect((await stat(project.workingDirectory)).isDirectory()).toBe(true);
      expect(await store.get(session.id)).not.toBeNull();
      expect(unlock).not.toHaveBeenCalled();
      exited.resolve();
      await deleting;
      await expect(stat(project.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(unlock).toHaveBeenCalledOnce();
    } finally {
      exited.resolve();
      service.dispose();
    }
  });

  it('keeps the conversation and checkout when terminal teardown refuses', async () => {
    const { project, store, session, service, releases } = await serviceFixture(undefined, async () => {
      throw new Error('Terminal did not exit');
    });
    try {
      await expect(service.deleteSession(session.id, true)).rejects.toThrow('Terminal did not exit');
      expect(releases).not.toContain('terminal');
      expect(await store.get(session.id)).not.toBeNull();
      expect((await stat(project.workingDirectory)).isDirectory()).toBe(true);
    } finally {
      service.dispose();
    }
  });

  it('unlocks terminal creation after Git refuses removal', async () => {
    const { project, store, session, service, releases } = await serviceFixture();
    try {
      await git(project.directory, ['worktree', 'lock', project.workingDirectory]);
      await expect(service.deleteSession(session.id, true)).rejects.toThrow('locked');
      expect(releases).toContain('terminal-unlock');
      expect(await store.get(session.id)).not.toBeNull();
      expect((await stat(project.workingDirectory)).isDirectory()).toBe(true);
    } finally {
      service.dispose();
    }
  });

  it.each(['create', 'update'])('waits for an in-flight %s binding before checking sharing', async kind => {
    const { project, store, session, service } = await serviceFixture();
    const other = await store.create(undefined, { mode: 'code' });
    const binding = deferred();
    const finishBinding = deferred();
    const create = store.create.bind(store);
    const setProject = store.setProject.bind(store);
    const createSpy = vi.spyOn(store, 'create').mockImplementation(async (...args) => {
      binding.resolve();
      await finishBinding.promise;
      return create(...args);
    });
    const updateSpy = vi.spyOn(store, 'setProject').mockImplementation(async (...args) => {
      binding.resolve();
      await finishBinding.promise;
      return setProject(...args);
    });
    try {
      const request = { directory: project.workingDirectory, workspace: false };
      const creating =
        kind === 'create'
          ? service.createCodeSession(request)
          : service.updateProject({ ...request, sessionId: other.id });
      await binding.promise;
      const inspect = vi.spyOn(store, 'workspaceProjectsExcept');
      const deleting = expect(service.deleteSession(session.id, true)).rejects.toThrow('another conversation');
      await Promise.resolve();
      expect(inspect).not.toHaveBeenCalled();
      finishBinding.resolve();
      expect((await creating).ok).toBe(true);
      await deleting;
      expect(await store.get(session.id)).not.toBeNull();
      expect((await stat(project.workingDirectory)).isDirectory()).toBe(true);
    } finally {
      finishBinding.resolve();
      createSpy.mockRestore();
      updateSpy.mockRestore();
      service.dispose();
    }
  });

  it.each(['create', 'update'])('refuses a %s binding queued behind checkout removal', async kind => {
    const acquiring = deferred();
    const exited = deferred();
    const { project, store, session, service } = await serviceFixture(undefined, async () => {
      acquiring.resolve();
      await exited.promise;
      return () => {};
    });
    const other = await store.create(undefined, { mode: 'code' });
    try {
      const deleting = service.deleteSession(session.id, true);
      await acquiring.promise;
      const request = { directory: project.workingDirectory, workspace: false };
      const binding =
        kind === 'create'
          ? service.createCodeSession(request)
          : service.updateProject({ ...request, sessionId: other.id });
      exited.resolve();
      await deleting;
      expect(await binding).toMatchObject({ ok: false, error: expect.stringContaining('ENOENT') });
      expect((await store.get(other.id))?.project).toBeUndefined();
      expect(await store.list()).toHaveLength(1);
    } finally {
      exited.resolve();
      service.dispose();
    }
  });

  it('counts archived conversations sharing the checkout and keeps the session after refusal', async () => {
    const { project, store, session, service } = await serviceFixture();
    try {
      const other = await store.create(undefined, {
        project: { ...project, workspace: false, workspaceBranch: undefined },
      });
      await store.setArchived(other.id, true);
      expect(await service.inspectSessionWorktreeRemoval(session.id)).toMatchObject({
        safe: false,
        reason: 'Used by another conversation',
      });
      await expect(service.deleteSession(session.id, true)).rejects.toThrow('another conversation');
      expect(await store.get(session.id)).not.toBeNull();
      expect((await stat(project.workingDirectory)).isDirectory()).toBe(true);
    } finally {
      service.dispose();
    }
  });

  it('rechecks shared state after releasing resources', async () => {
    const { project, store, session, service } = await serviceFixture(async (store, project) => {
      const other = await store.create(undefined, { project });
      await store.setArchived(other.id, true);
    });
    try {
      await expect(service.deleteSession(session.id, true)).rejects.toThrow('another conversation');
      expect(await store.get(session.id)).not.toBeNull();
      expect((await stat(project.workingDirectory)).isDirectory()).toBe(true);
    } finally {
      service.dispose();
    }
  });

  it('removes a checkout dirtied while resources are released and keeps its branch', async () => {
    let dirtied = false;
    const { project, store, session, service } = await serviceFixture(async (_store, project) => {
      if (dirtied) return;
      dirtied = true;
      await writeFile(join(project.workingDirectory, 'late.txt'), 'scratch');
    });
    try {
      await service.deleteSession(session.id, true, { allowDiscard: true });
      expect(await store.get(session.id)).toBeNull();
      await expect(stat(project.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      await git(project.directory, ['show-ref', '--verify', `refs/heads/${project.workspaceBranch}`]);
    } finally {
      service.dispose();
    }
  });

  it('keeps a checkout dirtied while resources are released when discarding is not allowed', async () => {
    let dirtied = false;
    const { project, store, session, service } = await serviceFixture(async (_store, project) => {
      if (dirtied) return;
      dirtied = true;
      await writeFile(join(project.workingDirectory, 'late.txt'), 'scratch');
    });
    try {
      await expect(service.deleteSession(session.id, true)).rejects.toThrow('uncommitted');
      expect(await store.get(session.id)).not.toBeNull();
      expect((await stat(join(project.workingDirectory, 'late.txt'))).isFile()).toBe(true);
    } finally {
      service.dispose();
    }
  });

  it('refuses to discard without allowDiscard, as host protocol deletes ask', async () => {
    const { project, store, session, service } = await serviceFixture();
    try {
      await writeFile(join(project.workingDirectory, 'work.txt'), 'keep this');
      await expect(service.deleteSession(session.id, true)).rejects.toThrow('1 uncommitted file');
      expect(await store.get(session.id)).not.toBeNull();
      expect((await stat(join(project.workingDirectory, 'work.txt'))).isFile()).toBe(true);
    } finally {
      service.dispose();
    }
  });

  it('keeps the checkout while another session is preparing a workspace', async () => {
    const { project, session, service } = await serviceFixture();
    try {
      (service as unknown as { preparing: Map<string, unknown> }).preparing.set('other', { since: 0, base: 'main' });
      expect(await service.inspectSessionWorktreeRemoval(session.id)).toMatchObject({
        removable: false,
        reason: 'A workspace is being prepared',
      });
      await expect(service.deleteSession(session.id, true, { allowDiscard: true })).rejects.toThrow('being prepared');
      expect((await stat(project.workingDirectory)).isDirectory()).toBe(true);
    } finally {
      service.dispose();
    }
  });

  it('removes only the nested worktrees named for removal, keeping a running one and continuing', async () => {
    const { project, store, session, service } = await serviceFixture();
    try {
      const nestedWorktree = async (name: string) => {
        const workingDirectory = join(appWorktreeRoot(project.directory), name);
        const workspaceBranch = `b4m/${name}`;
        await git(project.directory, ['worktree', 'add', '-qb', workspaceBranch, workingDirectory]);
        await writeFile(join(workingDirectory, 'scratch.txt'), 'scratch');
        return store.create(undefined, {
          project: { ...project, workspaceBranch, workingDirectory },
          origin: { parentSessionId: session.id, depth: 1, seedPrompt: name },
        });
      };
      const listed = await nestedWorktree('listed');
      const unlisted = await nestedWorktree('unlisted');
      const running = await nestedWorktree('running');
      const inFlight = vi.spyOn(service as unknown as { hasTurnInFlight(id: string): boolean }, 'hasTurnInFlight');
      inFlight.mockImplementation(id => id === running.id);
      const result = await service.deleteSessionTree(
        session.id,
        [listed.id, unlisted.id, running.id],
        true,
        [listed.id, running.id],
        { allowDiscard: true }
      );
      expect(result.error).toBeNull();
      expect(result.deleted).toEqual(expect.arrayContaining([listed.id, unlisted.id, running.id, session.id]));
      const exists = (path: string) =>
        stat(path).then(
          () => true,
          () => false
        );
      expect(await exists(listed.project!.workingDirectory)).toBe(false);
      expect(await exists(unlisted.project!.workingDirectory)).toBe(true);
      expect(await exists(running.project!.workingDirectory)).toBe(true);
      expect(await exists(project.workingDirectory)).toBe(false);
    } finally {
      service.dispose();
    }
  });

  it('deletes named nested sessions deepest first, then the parent and its shared checkout', async () => {
    const { project, store, session, service } = await serviceFixture();
    try {
      const shared = { ...project, workspace: false, workspaceBranch: project.workspaceBranch };
      const child = await store.create(undefined, {
        project: shared,
        origin: { parentSessionId: session.id, depth: 1, seedPrompt: 'child' },
      });
      const grandchild = await store.create(undefined, {
        origin: { parentSessionId: child.id, depth: 2, seedPrompt: 'grandchild' },
      });
      const unrelated = await store.create();
      expect(await service.inspectSessionWorktreeRemoval(session.id)).toMatchObject({ removable: false });
      expect(await service.inspectSessionWorktreeRemoval(session.id, [child.id])).toMatchObject({ removable: true });
      const result = await service.deleteSessionTree(session.id, [child.id, grandchild.id, unrelated.id], true);
      expect(result).toEqual({ deleted: [grandchild.id, child.id, session.id], error: null });
      expect((await store.list()).map(summary => summary.id)).toEqual([unrelated.id]);
      await expect(stat(project.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      service.dispose();
    }
  });

  it('leaves unnamed nested sessions and reports a failure with what was deleted', async () => {
    const { store, session, service } = await serviceFixture(async store => {
      const other = await store.create(undefined, { project: (await store.get(session.id))!.project });
      await store.setArchived(other.id, true);
    });
    try {
      const kept = await store.create(undefined, {
        origin: { parentSessionId: session.id, depth: 1, seedPrompt: 'kept' },
      });
      const named = await store.create(undefined, {
        origin: { parentSessionId: session.id, depth: 1, seedPrompt: 'named' },
      });
      const result = await service.deleteSessionTree(session.id, [named.id], true);
      expect(result).toEqual({ deleted: [named.id], error: expect.stringContaining('another conversation') });
      expect(await store.get(kept.id)).not.toBeNull();
      expect(await store.get(session.id)).not.toBeNull();
    } finally {
      service.dispose();
    }
  });

  it('refuses cleanup when another conversation cannot be read', async () => {
    const { project, store, session, service } = await serviceFixture();
    try {
      await writeFile(join(project.directory, '.b4m', 'sessions', 'broken.json'), '{');
      await expect(service.deleteSession(session.id, true)).rejects.toThrow();
      expect(await store.get(session.id)).not.toBeNull();
      expect((await stat(project.workingDirectory)).isDirectory()).toBe(true);
    } finally {
      service.dispose();
    }
  });

  it('checks workspace bindings across account and environment scopes', async () => {
    const project = await fixture();
    const directory = join(project.directory, '.b4m', 'scoped-sessions');
    const first = new SessionStore(directory, 'model', 'launch', () => ({
      environmentUrl: 'http://localhost:3000',
      accountId: 'first',
    }));
    const second = new SessionStore(directory, 'model', 'launch', () => ({
      environmentUrl: 'http://localhost:4000',
      accountId: 'second',
    }));
    const session = await first.create(undefined, { project });
    const other = await second.create(undefined, { project });
    await second.setArchived(other.id, true);
    const projects = await first.workspaceProjectsExcept(session.id);
    expect(await inspectWorktreeRemoval(project, projects)).toMatchObject({
      safe: false,
      reason: 'Used by another conversation',
    });
  });

  it('keeps worktrees by default for callers including the agent tool', async () => {
    const { project, store, session, service } = await serviceFixture();
    try {
      await service.deleteSession(session.id);
      expect(await store.get(session.id)).toBeNull();
      expect((await stat(project.workingDirectory)).isDirectory()).toBe(true);
    } finally {
      service.dispose();
    }
  });

  it('skips the conversation scan for a session without an app worktree', async () => {
    const { store, service } = await serviceFixture();
    try {
      const chat = await store.create();
      const scan = vi.spyOn(store, 'workspaceProjectsExcept');
      expect(await service.inspectSessionWorktreeRemoval(chat.id)).toBeNull();
      expect(scan).not.toHaveBeenCalled();
    } finally {
      service.dispose();
    }
  });
});

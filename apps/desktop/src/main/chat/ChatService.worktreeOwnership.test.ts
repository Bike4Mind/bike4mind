import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatSessionSummary } from '@shared/chat';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import { git } from './project/git';
import { appWorktreeRoot } from './project/workspace';
import type { AccessStore } from './tools/AccessStore';

const resolution = vi.hoisted(() => ({
  afterResolve: null as ((path: string) => Promise<void>) | null,
}));

vi.mock('./project/workspace', async () => {
  const actual = await vi.importActual<typeof import('./project/workspace')>('./project/workspace');
  return {
    ...actual,
    resolveWorkspace: async (...args: Parameters<typeof actual.resolveWorkspace>) => {
      const result = await actual.resolveWorkspace(...args);
      await resolution.afterResolve?.(result.workingDirectory);
      return result;
    },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}

const roots: string[] = [];
const services: ChatService[] = [];
afterEach(async () => {
  resolution.afterResolve = null;
  vi.restoreAllMocks();
  services.splice(0).forEach(service => service.dispose());
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'b4m-owner-race-')));
  roots.push(directory);
  await git(directory, ['init', '-q', '--initial-branch=main']);
  await git(directory, ['config', 'user.email', 'test@example.com']);
  await git(directory, ['config', 'user.name', 'Test']);
  await writeFile(join(directory, '.gitignore'), '.b4m/\n');
  await git(directory, ['add', '.gitignore']);
  await git(directory, ['commit', '-qm', 'initial']);
  const sessions = join(directory, '.b4m', 'sessions');
  await mkdir(sessions, { recursive: true });
  const store = new SessionStore(sessions, 'test-model');
  const service = new ChatService({
    store,
    access: { list: async () => [] } as unknown as AccessStore,
    logger: { debug: vi.fn(), warn: vi.fn() },
    getApiClient: () => null,
    getEnvironmentUrl: () => 'http://localhost:3000',
    emit: vi.fn(),
  });
  services.push(service);
  return { directory, store, service };
}

type OwnershipMethods = {
  ensureWorkspace(session: Pick<ChatSession, 'id' | 'project'>, name: string): Promise<{ error: string } | null>;
  grantSessionDirectory(
    sessionId: string,
    directory: string
  ): Promise<{ ok: true; session: ChatSessionSummary } | { ok: false }>;
};

/** First lease is cleanup; the second is the concurrent ownership write waiting behind it. */
function observeQueuedBinding(store: SessionStore) {
  const queued = deferred<void>();
  const withBindings = store.withWorkspaceBindings.bind(store);
  let calls = 0;
  vi.spyOn(store, 'withWorkspaceBindings').mockImplementation(operation => {
    calls++;
    if (calls === 2) queued.resolve();
    return withBindings(operation);
  });
  return queued.promise;
}

describe('worktree ownership writes during orphan cleanup', () => {
  it('holds a newly created checkout until its binding can be persisted after cleanup', async () => {
    const { directory, store, service } = await fixture();
    const created = await store.create(undefined, {
      project: {
        directory,
        name: 'repo',
        branch: 'main',
        workspace: true,
        workingDirectory: directory,
        contextDirectories: [],
      },
    });
    const session = await store.get(created.id);
    if (!session) throw new Error('Missing fixture session');
    const checkoutCreated = deferred<string>();
    const releaseResolver = deferred<void>();
    resolution.afterResolve = async path => {
      checkoutCreated.resolve(path);
      await releaseResolver.promise;
    };
    const preparation = (service as unknown as OwnershipMethods).ensureWorkspace(session, 'race fixture');
    const path = await checkoutCreated.promise;
    const bindingQueued = observeQueuedBinding(store);
    const ownersExcept = store.workspaceOwnersExcept.bind(store);
    vi.spyOn(store, 'workspaceOwnersExcept').mockImplementation(async id => {
      const snapshot = await ownersExcept(id);
      releaseResolver.resolve();
      // Correct code queues its binding. Without that lease, preparation completes and clears
      // the hold before cleanup uses this snapshot, reproducing the original deletion race.
      await Promise.race([bindingQueued, preparation]);
      return snapshot;
    });

    const [result] = await service.removeWorktrees(directory, [path]);
    expect(await preparation).toBeNull();
    expect(result).toMatchObject({ status: 'skipped', message: 'A workspace is being prepared' });
    expect((await stat(path)).isDirectory()).toBe(true);
    expect((await store.get(created.id))?.project?.workingDirectory).toBe(path);
  });

  it('revalidates a queued directory grant after cleanup removes the checkout', async () => {
    const { directory, store, service } = await fixture();
    const path = join(appWorktreeRoot(directory), 'orphan');
    await git(directory, ['worktree', 'add', '-qb', 'b4m/orphan-race', path]);
    const session = await store.create();
    const bindingQueued = observeQueuedBinding(store);
    const ownersExcept = store.workspaceOwnersExcept.bind(store);
    const grantResult = deferred<{ ok: boolean }>();
    vi.spyOn(store, 'workspaceOwnersExcept').mockImplementation(async id => {
      const snapshot = await ownersExcept(id);
      const grant = (service as unknown as OwnershipMethods).grantSessionDirectory(session.id, path);
      void grant.then(grantResult.resolve);
      // Without the lease, the grant finishes against the still-existing checkout; cleanup
      // then deletes it using the snapshot taken before the new grant was recorded.
      await Promise.race([bindingQueued, grant]);
      return snapshot;
    });

    expect((await service.removeWorktrees(directory, [path]))[0]).toMatchObject({ status: 'removed' });
    expect(await grantResult.promise).toEqual({ ok: false });
    expect((await store.get(session.id))?.grantedDirectories ?? []).not.toContain(path);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a directory grant queued under an account that changed before the lease was acquired', async () => {
    const { directory, store, service } = await fixture();
    const session = await store.create();
    let scopeKey = 'original-account';
    vi.spyOn(store, 'scopeKey').mockImplementation(() => scopeKey);
    const addGrantedDirectory = vi.spyOn(store, 'addGrantedDirectory');
    const leaseAcquired = deferred<void>();
    const releaseLease = deferred<void>();
    const heldLease = store.withWorkspaceBindings(async () => {
      leaseAcquired.resolve();
      await releaseLease.promise;
    });
    await leaseAcquired.promise;

    const grant = (service as unknown as OwnershipMethods).grantSessionDirectory(session.id, directory);
    scopeKey = 'another-account';
    releaseLease.resolve();

    expect(await grant).toEqual({ ok: false });
    await heldLease;
    expect(addGrantedDirectory).not.toHaveBeenCalled();
    expect((await store.get(session.id))?.grantedDirectories ?? []).not.toContain(directory);
  });
});

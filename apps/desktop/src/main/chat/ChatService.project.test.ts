import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { BackgroundProcessInfo, ChatQueueEvent, ChatStreamEvent } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { MessageQueue } from './MessageQueue';
import { SessionStore } from './SessionStore';
import { branchExists, currentBranch, git, listWorktrees } from './project/git';
import { appWorktreeRoot, worktreeFolderName } from './project/workspace';
import type { AccessStore } from './tools/AccessStore';
import type { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';

/** A real repository in the user's layout, because resolveWorkspace is what decides the path. */
async function repository(name: string): Promise<{ container: string; main: string }> {
  // realpath because on macOS tmpdir() is a symlink into /private and git reports resolved paths.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-chip-')));

  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  await git(source, ['init', '--initial-branch=main', '--quiet']);
  await git(source, ['config', 'user.email', 'test@example.com']);
  await git(source, ['config', 'user.name', 'Test']);
  await writeFile(join(source, 'README.md'), `${name}\n`, 'utf8');
  await git(source, ['add', '.']);
  await git(source, ['commit', '--quiet', '-m', 'first']);

  const container = join(root, name);
  await mkdir(container, { recursive: true });
  await git(container, ['clone', '--bare', '--quiet', source, '.bare']);

  const bare = join(container, '.bare');
  const main = join(container, 'main');
  await git(bare, ['worktree', 'add', '--quiet', main, 'main']);
  // The gitlink the user's `worktree` helper writes, which is what makes git answer from the
  // container at all - and so what makes the container look pickable.
  await writeFile(join(container, '.git'), 'gitdir: ./.bare\n', 'utf8');

  return { container, main };
}

describe('ChatService tool scope for a session saved on the bare repo', () => {
  async function serviceWith(store: SessionStore): Promise<ChatService> {
    return new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => null,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: vi.fn(),
    });
  }

  async function savedOnBare(workspace: boolean, branch: string) {
    const { container, main } = await repository('theta');
    await git(join(container, '.bare'), ['config', 'core.bare', 'false']);
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-chip-sessions-')), 'test-model');
    const service = await serviceWith(store);
    const created = await service.createCodeSession({ directory: main, branch, workspace: false });
    if (!created.ok) throw new Error(created.error);
    await store.setProject(created.session.id, {
      directory: main,
      name: 'theta',
      branch,
      workspace,
      workingDirectory: join(container, '.bare'),
      contextDirectories: [],
    });
    const scope = await (
      service as unknown as { resolveToolScope(s: unknown): Promise<{ roots: string[] }> }
    ).resolveToolScope(await store.get(created.session.id));
    return { container, main, store, id: created.session.id, scope };
  }

  it('moves a worktree session onto the worktree holding its branch and saves it', async () => {
    const { main, store, id, scope } = await savedOnBare(true, 'main');

    expect(scope.roots[0]).toBe(main);
    expect((await store.get(id))?.project?.workingDirectory).toBe(main);
  });

  it('falls back to the picked directory when no worktree is involved', async () => {
    const { main, store, id, scope } = await savedOnBare(false, 'main');

    expect(scope.roots[0]).toBe(main);
    expect((await store.get(id))?.project?.workingDirectory).toBe(main);
  });
});

describe('ChatService.updateProject', () => {
  let store: SessionStore;
  let service: ChatService;
  let running: BackgroundProcessInfo[];

  beforeEach(async () => {
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-chip-sessions-')), 'test-model');
    running = [];
    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      // A process with no sessionId stands for one in whichever session is asked about.
      background: {
        list: (sessionId: string) => running.filter(entry => !entry.sessionId || entry.sessionId === sessionId),
        sessionsWithRunning: () =>
          new Set(running.filter(entry => entry.status === 'running' && entry.sessionId).map(entry => entry.sessionId)),
      } as unknown as BackgroundProcessRegistry,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => null,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: vi.fn(),
    });
  });

  async function codeSession(directory: string, branch = 'main'): Promise<string> {
    const created = await service.createCodeSession({ directory, branch, workspace: false });
    if (!created.ok) throw new Error(created.error);
    return created.session.id;
  }

  /**
   * Ticking the box is a choice, not an act. Cutting on the tick meant a branch and a folder
   * per change of mind - a user who ticked it, looked at the branch list and picked a different
   * base left a worktree behind for the one they rejected.
   */
  it('records the worktree choice without creating anything', async () => {
    const { main } = await repository('alpha');
    const id = await codeSession(main);
    const before = await listWorktrees(main);

    const result = await service.updateProject({ sessionId: id, branch: 'feat/chips', workspace: true });

    expect(result).toMatchObject({ ok: true });
    expect((await service.getSession(id))?.project).toMatchObject({
      branch: 'feat/chips',
      workspace: true,
      workingDirectory: main,
    });
    expect((await service.getSession(id))?.project?.workspaceBranch).toBeUndefined();
    expect(await listWorktrees(main)).toEqual(before);
  });

  it('leaves nothing behind when the base is picked over and over', async () => {
    const { main } = await repository('alpha-rethink');
    const id = await codeSession(main);
    const before = await listWorktrees(main);

    await service.updateProject({ sessionId: id, branch: 'main', workspace: true });
    await service.updateProject({ sessionId: id, branch: 'feat/one', workspace: true });
    await service.updateProject({ sessionId: id, branch: 'feat/two', workspace: true });

    expect(await listWorktrees(main)).toEqual(before);
  });

  /** Re-picking the branch already checked out runs no switch and creates no worktree. */
  it('creates nothing at all with the worktree toggle off', async () => {
    const { main } = await repository('alpha-off');
    const id = await codeSession(main);
    const before = await listWorktrees(main);

    expect(await service.updateProject({ sessionId: id, branch: 'main' })).toMatchObject({ ok: true });

    expect((await service.getSession(id))?.project).toMatchObject({
      branch: 'main',
      workspace: false,
      workingDirectory: main,
    });
    expect(await listWorktrees(main)).toEqual(before);
  });

  it('checks the picked branch out in place with the toggle off, so HEAD follows the pick', async () => {
    const { main } = await repository('off-switch');
    await git(main, ['branch', 'feat/chips']);
    const id = await codeSession(main);
    const before = await listWorktrees(main);

    expect(await service.updateProject({ sessionId: id, branch: 'feat/chips' })).toMatchObject({ ok: true });

    expect(await currentBranch(main)).toBe('feat/chips');
    expect((await service.getSession(id))?.project).toMatchObject({ branch: 'feat/chips', workingDirectory: main });
    expect(await listWorktrees(main)).toHaveLength(before.length);
  });

  it('creates and checks out a new branch from the filter with the toggle off', async () => {
    const { main } = await repository('off-create');
    const id = await codeSession(main);
    const head = (await git(main, ['rev-parse', 'HEAD'])).trim();

    expect(await service.updateProject({ sessionId: id, branch: 'feat/brand-new' })).toMatchObject({ ok: true });

    expect(await currentBranch(main)).toBe('feat/brand-new');
    expect((await git(main, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect((await service.getSession(id))?.project?.branch).toBe('feat/brand-new');
  });

  it('refuses a toggle-off switch over uncommitted changes, and leaves both sides as they were', async () => {
    const { main } = await repository('off-dirty');
    await git(main, ['branch', 'feat/chips']);
    const id = await codeSession(main);
    await writeFile(join(main, 'README.md'), 'edited\n', 'utf8');

    const result = await service.updateProject({ sessionId: id, branch: 'feat/chips' });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/uncommitted changes \(README\.md\)/);
    expect(await currentBranch(main)).toBe('main');
    expect(await readFile(join(main, 'README.md'), 'utf8')).toBe('edited\n');
    expect((await service.getSession(id))?.project?.branch).toBe('main');
  });

  it('refuses a new branch over uncommitted changes too, creating nothing', async () => {
    const { main } = await repository('off-dirty-create');
    const id = await codeSession(main);
    await writeFile(join(main, 'README.md'), 'edited\n', 'utf8');

    expect(await service.updateProject({ sessionId: id, branch: 'feat/brand-new' })).toMatchObject({ ok: false });
    expect(await branchExists(main, 'feat/brand-new')).toBe(false);
  });

  it('is not stopped by an untracked file the switch would carry untouched', async () => {
    const { main } = await repository('off-untracked');
    await git(main, ['branch', 'feat/chips']);
    const id = await codeSession(main);
    await writeFile(join(main, 'scratch.log'), 'noise\n', 'utf8');

    expect(await service.updateProject({ sessionId: id, branch: 'feat/chips' })).toMatchObject({ ok: true });
    expect(await currentBranch(main)).toBe('feat/chips');
  });

  it('refuses while another session has a turn running in the same folder', async () => {
    const { main } = await repository('off-shared-turn');
    await git(main, ['branch', 'feat/chips']);
    const id = await codeSession(main);
    const other = await codeSession(main);
    (service as unknown as { active: Map<string, AbortController> }).active.set(other, new AbortController());

    const result = await service.updateProject({ sessionId: id, branch: 'feat/chips' });

    expect(result).toMatchObject({ ok: false, busy: true });
    expect(await currentBranch(main)).toBe('main');
    expect((await service.getSession(id))?.project?.branch).toBe('main');
  });

  it('refuses while another session has a background process alive in the same folder', async () => {
    const { main } = await repository('off-shared-process');
    await git(main, ['branch', 'feat/chips']);
    const id = await codeSession(main);
    const other = await codeSession(main);
    running = [{ sessionId: other, command: 'pnpm dev', status: 'running' } as BackgroundProcessInfo];

    expect(await service.updateProject({ sessionId: id, branch: 'feat/chips' })).toMatchObject({
      ok: false,
      busy: true,
    });
    expect(await currentBranch(main)).toBe('main');
  });

  it('is not stopped by a busy session in a different folder', async () => {
    const { main } = await repository('off-elsewhere');
    const elsewhere = await repository('off-elsewhere-b');
    await git(main, ['branch', 'feat/chips']);
    const id = await codeSession(main);
    const other = await codeSession(elsewhere.main);
    (service as unknown as { active: Map<string, AbortController> }).active.set(other, new AbortController());

    expect(await service.updateProject({ sessionId: id, branch: 'feat/chips' })).toMatchObject({ ok: true });
  });

  it('refuses a toggle-off switch once the conversation has run', async () => {
    const { main } = await repository('off-in-use');
    await git(main, ['branch', 'feat/chips']);
    const id = await codeSession(main);
    await store.appendMessage(id, { id: 'm1', role: 'user', content: 'hi', createdAt: new Date().toISOString() });

    const result = await service.updateProject({ sessionId: id, branch: 'feat/chips' });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/already run here/i);
    expect(await currentBranch(main)).toBe('main');
  });

  it('checks nothing out when the toggle is on: the pick is the base of a later cut', async () => {
    const { main } = await repository('on-no-switch');
    await git(main, ['branch', 'feat/chips']);
    const id = await codeSession(main);

    expect(await service.updateProject({ sessionId: id, branch: 'feat/chips', workspace: true })).toMatchObject({
      ok: true,
    });
    expect(await currentBranch(main)).toBe('main');
  });

  it('turning it back off returns the session to the project directory', async () => {
    const { main } = await repository('beta');
    const id = await codeSession(main);
    await service.updateProject({ sessionId: id, branch: 'feat/chips', workspace: true });

    await service.updateProject({ sessionId: id, workspace: false });

    expect((await service.getSession(id))?.project).toMatchObject({ workspace: false, workingDirectory: main });
  });

  it('refuses while a background process is still alive in the current working directory', async () => {
    const { main } = await repository('gamma');
    const id = await codeSession(main);
    running = [{ command: 'pnpm dev', status: 'running' } as BackgroundProcessInfo];

    const result = await service.updateProject({ sessionId: id, branch: 'feat/chips', workspace: true });

    expect(result).toMatchObject({ ok: false, busy: true });
    expect(result.ok === false && result.error).toContain('pnpm dev');
    // The refusal must leave the binding untouched, or the session would claim a worktree it
    // never moved to while the process kept running in the old one.
    expect((await service.getSession(id))?.project).toMatchObject({ workspace: false, workingDirectory: main });
  });

  it('a process that has already exited does not block the change', async () => {
    const { main } = await repository('delta');
    const id = await codeSession(main);
    running = [{ command: 'pnpm build', status: 'exited' } as BackgroundProcessInfo];

    expect(await service.updateProject({ sessionId: id, branch: 'feat/chips', workspace: true })).toMatchObject({
      ok: true,
    });
  });

  it('moving to another repository drops the old branch and context folders', async () => {
    const first = await repository('epsilon');
    const second = await repository('zeta');
    const id = await codeSession(first.main);
    await service.addContextDirectory(id, first.container);

    const result = await service.updateProject({ sessionId: id, directory: second.main });

    expect(result).toMatchObject({ ok: true });
    expect((await service.getSession(id))?.project).toMatchObject({
      directory: second.main,
      branch: '',
      contextDirectories: [],
      workingDirectory: second.main,
    });
  });

  it('refuses a Chat session, which has no project to re-ground', async () => {
    const { id } = await service.createSession();

    expect(await service.updateProject({ sessionId: id })).toMatchObject({ ok: false });
  });

  /**
   * The container is not somewhere a session can run: no branch is checked out in it, so its
   * tools would sit beside every worktree rather than in one, and git answers there for the
   * bare repo - which is where the chip's confident wrong branch name came from.
   */
  it('refuses the worktree container as a project and points at the checkouts inside', async () => {
    const { container, main } = await repository('gamma');
    const id = await codeSession(main);

    const result = await service.updateProject({ sessionId: id, directory: container });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/not a checkout/i);
    expect((await service.getSession(id))?.project).toMatchObject({ directory: main });
  });

  it('refuses to start a session in the container in the first place', async () => {
    const { container } = await repository('delta');

    const created = await service.createCodeSession({ directory: container, branch: '', workspace: false });

    expect(created).toMatchObject({ ok: false });
    expect(created.ok === false && created.error).toMatch(/not a checkout/i);
  });
});

/**
 * The group header's "+" starts another session in a project the user already has one in. What
 * it may carry from the session beside it is decided in the renderer (newSessionInProject); what
 * each choice COSTS is here, against a real container in the layout that produced the bug: a
 * `main` folder that has since been checked out onto another branch.
 */
describe('starting a second session in a project whose main worktree moved', () => {
  async function serviceOn(): Promise<{ service: ChatService; main: string }> {
    const { main } = await repository('theta-sibling');
    await git(main, ['config', 'user.email', 'test@example.com']);
    await git(main, ['config', 'user.name', 'Test']);
    await git(main, ['checkout', '--quiet', '-b', 'fix/scrub-missing-knowledge-ids']);

    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-chip-sessions-')), 'test-model');
    const service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => null,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: vi.fn(),
    });
    return { service, main };
  }

  /**
   * This used to fail: `main` resolved to <container>/main, the folder that had since been
   * checked out onto another branch, and the refusal was the app declining to clobber it. The
   * collision is gone now that nothing the app creates shares a parent with the user's folders.
   */
  it('binds without colliding with the moved checkout', async () => {
    const { service, main } = await serviceOn();

    const result = await service.createCodeSession({ directory: main, branch: 'main', workspace: true });

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && (await service.getSession(result.session.id))?.project).toMatchObject({
      branch: 'main',
      workspace: true,
      workingDirectory: main,
    });
  });

  it('succeeds carrying the folder alone, and the session starts with no branch', async () => {
    const { service, main } = await serviceOn();

    const result = await service.createCodeSession({ directory: main });

    expect(result).toMatchObject({ ok: true });
    const project = result.ok ? (await service.getSession(result.session.id))?.project : null;
    expect(project).toMatchObject({
      directory: main,
      branch: '',
      workspace: false,
      workingDirectory: main,
      contextDirectories: [],
    });
  });

  it('accepts the same choice made deliberately on the new session', async () => {
    const { service, main } = await serviceOn();
    const created = await service.createCodeSession({ directory: main });
    if (!created.ok) throw new Error(created.error);

    const result = await service.updateProject({ sessionId: created.session.id, branch: 'main', workspace: true });

    expect(result).toMatchObject({ ok: true });
    expect((await service.getSession(created.session.id))?.project?.workspace).toBe(true);
  });
});

/**
 * The worktree is cut by the first TURN, not by the toggle.
 *
 * These drive `send` rather than `updateProject`, because the move is the whole point: until a
 * turn runs there is nothing to isolate, and the user is still free to change their mind about
 * the base for nothing.
 */
describe('the worktree a Code session gets on its first turn', () => {
  let store: SessionStore;
  let service: ChatService;
  let signedIn: boolean;

  beforeEach(async () => {
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-chip-sessions-')), 'test-model');
    signedIn = true;
    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      // Signed in by default, so a refusal here is about the worktree and nothing else. The
      // reply that follows acceptance fails against this stub, which these tests never read.
      getApiClient: () => (signedIn ? ({} as AuthenticatedApiClient) : null),
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: vi.fn(),
    });
  });

  async function bound(directory: string, branch: string): Promise<string> {
    const created = await service.createCodeSession({ directory, branch, workspace: true });
    if (!created.ok) throw new Error(created.error);
    return created.session.id;
  }

  it('cuts the branch and the worktree when the first message is sent', async () => {
    const { container, main } = await repository('turn-first');
    const id = await bound(main, 'main');
    expect((await service.getSession(id))?.project?.workingDirectory).toBe(main);

    await service.send(id, 'Fix the login form');

    const project = (await service.getSession(id))?.project;
    expect(project?.branch).toBe('main');
    expect(project?.workspaceBranch).toMatch(/^b4m\/fix-the-login-form-[0-9a-f]{6}$/);
    expect(project?.workingDirectory).toBe(
      join(appWorktreeRoot(container), worktreeFolderName(project?.workspaceBranch ?? ''))
    );
    expect(project?.workingDirectory).not.toBe(main);
  });

  /**
   * The session is still called 'New chat' at this point, which is what filled a container with
   * b4m+new-chat-* folders. The prompt is the first description of the work that exists.
   */
  it('names the branch after the prompt rather than the untouched session title', async () => {
    const { main } = await repository('turn-named');
    const id = await bound(main, 'main');

    await service.send(id, 'Add a retry to the uploader');

    expect((await service.getSession(id))?.project?.workspaceBranch).toMatch(/^b4m\/add-a-retry-to-the-uploader-/);
  });

  /**
   * The severe one at this user's volume: a second turn that cut another branch would leave a
   * worktree per message.
   */
  it('reuses the same worktree on every turn after the first', async () => {
    const { main } = await repository('turn-again');
    const id = await bound(main, 'main');
    await service.send(id, 'first');
    const first = (await service.getSession(id))?.project;

    await service.send(id, 'second');

    expect((await service.getSession(id))?.project).toMatchObject({
      workspaceBranch: first?.workspaceBranch,
      workingDirectory: first?.workingDirectory,
    });
    expect((await listWorktrees(main)).filter(entry => entry.branch?.startsWith('b4m/'))).toHaveLength(1);
  });

  it('keeps the worktree across a later change that is not about the base', async () => {
    const { main } = await repository('turn-kept');
    const id = await bound(main, 'main');
    await service.send(id, 'do the thing');
    const made = (await service.getSession(id))?.project;

    await service.updateProject({ sessionId: id, branch: 'main', workspace: true });

    expect((await service.getSession(id))?.project).toMatchObject({
      workspaceBranch: made?.workspaceBranch,
      workingDirectory: made?.workingDirectory,
    });
  });

  it('runs in the project directory, and creates nothing, with the toggle off', async () => {
    const { main } = await repository('turn-off');
    const created = await service.createCodeSession({ directory: main, branch: 'main', workspace: false });
    if (!created.ok) throw new Error(created.error);
    const before = await listWorktrees(main);

    await service.send(created.session.id, 'do the thing');

    expect((await service.getSession(created.session.id))?.project?.workingDirectory).toBe(main);
    expect(await listWorktrees(main)).toEqual(before);
  });

  /**
   * The refusal moved with the creation: it reaches the user as the turn being turned away,
   * which is where they are looking, rather than minutes earlier on a toggle.
   */
  it('refuses the turn, and stores no prompt, when the worktree cannot be made', async () => {
    const { container, main } = await repository('turn-blocked');
    const id = await bound(main, 'feat/chips');
    await mkdir(join(appWorktreeRoot(container), 'feat+chips'), { recursive: true });
    await writeFile(join(appWorktreeRoot(container), 'feat+chips', 'stray.txt'), 'not mine\n', 'utf8');

    const sent = await service.send(id, 'do the thing');

    expect(sent.ok).toBe(false);
    expect(sent.ok === false && sent.error).toMatch(/already exists but is not a git worktree/);
    expect((await store.get(id))?.messages ?? []).toHaveLength(0);
    expect((await service.getSession(id))?.project?.workingDirectory).toBe(main);
    // Untouched, which is the other half of refusing rather than adopting.
    expect(await readFile(join(appWorktreeRoot(container), 'feat+chips', 'stray.txt'), 'utf8')).toBe('not mine\n');
  });

  /**
   * A turn turned away before it is accepted must not have cut anything either, which is what
   * puts this after the rest of send's refusals rather than at the top of it.
   */
  it('creates nothing for a turn refused for an unrelated reason', async () => {
    const { main } = await repository('turn-refused');
    const id = await bound(main, 'main');
    const before = await listWorktrees(main);
    signedIn = false;

    const sent = await service.send(id, 'do the thing');

    expect(sent.ok).toBe(false);
    expect(sent.ok === false && sent.error).toMatch(/sign in/i);
    expect(await listWorktrees(main)).toEqual(before);
    expect((await service.getSession(id))?.project?.workingDirectory).toBe(main);
  });
});

/**
 * The status line the renderer draws while a first turn waits on its worktree is fed by these
 * events, so they have to open, name the branch, and close on every path.
 */
describe('the worktree status a first turn reports', () => {
  let store: SessionStore;
  let service: ChatService;
  let events: ChatStreamEvent[];
  let queueEvents: ChatQueueEvent[];
  let onEvent: (event: ChatStreamEvent) => void;

  beforeEach(async () => {
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-status-sessions-')), 'test-model');
    events = [];
    queueEvents = [];
    onEvent = () => undefined;
    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => ({}) as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => {
        events.push(event);
        onEvent(event);
      },
      queue: new MessageQueue(event => queueEvents.push(event)),
    });
  });

  const workspaceEvents = () => events.filter(event => event.type === 'workspace');

  async function bound(directory: string, branch: string): Promise<string> {
    const created = await service.createCodeSession({ directory, branch, workspace: true });
    if (!created.ok) throw new Error(created.error);
    return created.session.id;
  }

  it('opens, names the branch, and closes before the reply starts', async () => {
    const { main } = await repository('status-first');
    const id = await bound(main, 'main');

    await service.send(id, 'Fix the login form');

    const branch = (await service.getSession(id))?.project?.workspaceBranch;
    expect(workspaceEvents()).toEqual([
      { type: 'workspace', sessionId: id, running: true, base: 'main' },
      { type: 'workspace', sessionId: id, running: true, base: 'main', branch },
      { type: 'workspace', sessionId: id, running: false, base: 'main' },
    ]);
    const closed = events.findIndex(event => event.type === 'workspace' && !event.running);
    expect(events.findIndex(event => event.type === 'start')).toBeGreaterThan(closed);
  });

  it('says nothing on a turn whose session is already in its worktree', async () => {
    const { main } = await repository('status-again');
    const id = await bound(main, 'main');
    await service.send(id, 'first');
    events.length = 0;

    await service.send(id, 'second');

    expect(workspaceEvents()).toEqual([]);
  });

  it('says nothing with the worktree toggle off', async () => {
    const { main } = await repository('status-off');
    const created = await service.createCodeSession({ directory: main, branch: 'main', workspace: false });
    if (!created.ok) throw new Error(created.error);

    await service.send(created.session.id, 'do the thing');

    expect(workspaceEvents()).toEqual([]);
  });

  it('closes when the worktree cannot be made, and hands back what was typed meanwhile', async () => {
    const { container, main } = await repository('status-blocked');
    const id = await bound(main, 'feat/chips');
    await mkdir(join(appWorktreeRoot(container), 'feat+chips'), { recursive: true });
    await writeFile(join(appWorktreeRoot(container), 'feat+chips', 'stray.txt'), 'not mine\n', 'utf8');
    let typedAhead: Promise<unknown> | undefined;
    onEvent = event => {
      if (event.type === 'workspace' && event.running && !typedAhead) typedAhead = service.send(id, 'and also');
    };

    const sent = await service.send(id, 'do the thing');

    expect(sent.ok).toBe(false);
    expect(await typedAhead).toMatchObject({ ok: true, queued: true });
    await vi.waitFor(() => expect(queueEvents.some(event => event.returned?.reason === 'refused')).toBe(true));
    expect(workspaceEvents().at(-1)).toMatchObject({ running: false });
    expect(service.isSessionBusy(id)).toBe(false);
  });

  it('queues a message sent while the worktree is being cut rather than cutting a second one', async () => {
    const { main } = await repository('status-race');
    const id = await bound(main, 'main');
    let typedAhead: Promise<unknown> | undefined;
    onEvent = event => {
      if (event.type === 'workspace' && event.running && !typedAhead) typedAhead = service.send(id, 'and also');
    };

    await service.send(id, 'first');

    expect(await typedAhead).toMatchObject({ ok: true, queued: true });
    expect((await listWorktrees(main)).filter(entry => entry.branch?.startsWith('b4m/'))).toHaveLength(1);
  });
});

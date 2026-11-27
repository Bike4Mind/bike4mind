import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

vi.mock('../git/hostGitArgs', async importOriginal =>
  (await import('./plainFolderGit.testHelper')).skipGitOutsideRepositories(await importOriginal())
);

const TEMPLATE_NAME = 'template-repository';
let template: Promise<string> | undefined;

/**
 * A real repository in the user's layout, because resolveWorkspace is what decides the path.
 *
 * Copied from one built per file: building it takes ten git processes. git records the source,
 * container and worktree as absolute paths in the files rewritten below.
 */
async function repository(name: string): Promise<{ container: string; main: string }> {
  template ??= buildRepository(TEMPLATE_NAME).then(({ container }) => dirname(container));
  const from = await template;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-chip-')));
  await cp(from, root, { recursive: true });
  const container = join(root, name);
  await rename(join(root, TEMPLATE_NAME), container);
  for (const file of [join(container, 'main', '.git'), join(container, '.bare', 'worktrees', 'main', 'gitdir')]) {
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replaceAll(join(from, TEMPLATE_NAME), container), 'utf8');
  }
  const config = join(container, '.bare', 'config');
  await writeFile(config, (await readFile(config, 'utf8')).replaceAll(from, root), 'utf8');
  return { container, main: join(container, 'main') };
}

async function buildRepository(name: string): Promise<{ container: string; main: string }> {
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
  // The clone does not inherit the source's identity, and CI has no global one to fall back on.
  await git(bare, ['config', 'user.email', 'test@example.com']);
  await git(bare, ['config', 'user.name', 'Test']);
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
  it('records the worktree choice and every later pick of base without creating or checking out anything', async () => {
    const { main } = await repository('alpha');
    await git(main, ['branch', 'feat/chips']);
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
    // The pick is the base of a later cut, so nothing is checked out here.
    expect(await currentBranch(main)).toBe('main');

    await service.updateProject({ sessionId: id, branch: 'main', workspace: true });
    await service.updateProject({ sessionId: id, branch: 'feat/one', workspace: true });
    await service.updateProject({ sessionId: id, branch: 'feat/two', workspace: true });
    expect(await listWorktrees(main)).toEqual(before);

    // Turning it back off returns the session to the project directory.
    await service.updateProject({ sessionId: id, workspace: false });
    expect((await service.getSession(id))?.project).toMatchObject({ workspace: false, workingDirectory: main });
  });

  describe('worktree with no branch picked', () => {
    it('defaults the base to main instead of refusing, on create and on update, and creates nothing', async () => {
      const { main } = await repository('default-main');
      const before = await listWorktrees(main);

      const created = await service.createCodeSession({ directory: main, workspace: true });

      expect(created).toMatchObject({ ok: true });
      if (!created.ok) return;
      expect(created.session.project).toMatchObject({ branch: 'main', workspace: true, workingDirectory: main });

      const id = await codeSession(main, '');
      expect(await service.updateProject({ sessionId: id, workspace: true })).toMatchObject({ ok: true });
      expect((await service.getSession(id))?.project?.branch).toBe('main');
      expect(await listWorktrees(main)).toEqual(before);
    });

    it('falls back to the repository default when there is no main', async () => {
      const { main } = await repository('default-master');
      await git(main, ['branch', '-m', 'main', 'master']);

      const created = await service.createCodeSession({ directory: main, workspace: true });

      expect(created).toMatchObject({ ok: true });
      if (!created.ok) return;
      expect(created.session.project?.branch).toBe('master');
    });
  });

  it('switches in place with the toggle off: a re-pick does nothing, a pick moves HEAD, a new name is created', async () => {
    const { main } = await repository('off-switch');
    await git(main, ['branch', 'feat/chips']);
    const id = await codeSession(main);
    const before = await listWorktrees(main);
    const head = (await git(main, ['rev-parse', 'HEAD'])).trim();

    // Re-picking the branch already checked out runs no switch and creates no worktree.
    expect(await service.updateProject({ sessionId: id, branch: 'main' })).toMatchObject({ ok: true });
    expect((await service.getSession(id))?.project).toMatchObject({
      branch: 'main',
      workspace: false,
      workingDirectory: main,
    });

    // An untracked file the switch would carry untouched is no reason to refuse it.
    await writeFile(join(main, 'scratch.log'), 'noise\n', 'utf8');
    expect(await service.updateProject({ sessionId: id, branch: 'feat/chips' })).toMatchObject({ ok: true });
    expect(await currentBranch(main)).toBe('feat/chips');
    expect((await service.getSession(id))?.project).toMatchObject({ branch: 'feat/chips', workingDirectory: main });

    expect(await service.updateProject({ sessionId: id, branch: 'feat/brand-new' })).toMatchObject({ ok: true });
    expect(await currentBranch(main)).toBe('feat/brand-new');
    expect((await git(main, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect((await service.getSession(id))?.project?.branch).toBe('feat/brand-new');
    expect(await listWorktrees(main)).toHaveLength(before.length);
  });

  it('refuses a toggle-off switch or new branch over uncommitted changes, leaving both sides as they were', async () => {
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

    expect(await service.updateProject({ sessionId: id, branch: 'feat/brand-new' })).toMatchObject({ ok: false });
    expect(await branchExists(main, 'feat/brand-new')).toBe(false);
  });

  it('refuses while another session in the same folder is busy, and only in the same folder', async () => {
    const { main } = await repository('off-shared');
    const elsewhere = await repository('off-shared-b');
    await git(main, ['branch', 'feat/chips']);
    const id = await codeSession(main);
    const other = await codeSession(main);
    const active = (service as unknown as { active: Map<string, AbortController> }).active;

    active.set(other, new AbortController());
    const result = await service.updateProject({ sessionId: id, branch: 'feat/chips' });
    expect(result, 'a turn running').toMatchObject({ ok: false, busy: true });
    expect(await currentBranch(main)).toBe('main');
    expect((await service.getSession(id))?.project?.branch).toBe('main');
    active.delete(other);

    running = [{ sessionId: other, command: 'pnpm dev', status: 'running' } as BackgroundProcessInfo];
    expect(await service.updateProject({ sessionId: id, branch: 'feat/chips' }), 'a background process').toMatchObject({
      ok: false,
      busy: true,
    });
    expect(await currentBranch(main)).toBe('main');
    running = [];

    active.set(await codeSession(elsewhere.main), new AbortController());
    expect(await service.updateProject({ sessionId: id, branch: 'feat/chips' }), 'busy elsewhere').toMatchObject({
      ok: true,
    });
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

  describe('a branch another worktree has checked out', () => {
    async function heldElsewhere(name: string): Promise<{ container: string; main: string; other: string }> {
      const made = await repository(name);
      const other = join(made.container, 'feat+held');
      await git(made.main, ['worktree', 'add', '--quiet', '-b', 'feat/held', other]);
      return { ...made, other };
    }

    it('is refused with the toggle off before git is asked to switch, naming where it is, and prunable once gone', async () => {
      const { main, other } = await heldElsewhere('held-off');
      const id = await codeSession(main);

      const result = await service.updateProject({ sessionId: id, branch: 'feat/held' });

      expect(result).toMatchObject({ ok: false, elsewhere: { branch: 'feat/held', path: other } });
      expect(result.ok === false && result.error).not.toMatch(/fatal:/i);
      expect(await currentBranch(main)).toBe('main');
      expect((await service.getSession(id))?.project?.branch).toBe('main');

      // Neither way on touches this folder, so its uncommitted work is no reason to withhold them.
      const readme = await readFile(join(main, 'README.md'), 'utf8');
      await writeFile(join(main, 'README.md'), 'edited\n', 'utf8');
      expect(await service.updateProject({ sessionId: id, branch: 'feat/held' })).toMatchObject({
        ok: false,
        elsewhere: { branch: 'feat/held' },
      });
      await writeFile(join(main, 'README.md'), readme, 'utf8');

      // A plain-object lookup found Object.prototype.constructor and refused the switch.
      await git(main, ['branch', 'constructor']);
      expect(await service.updateProject({ sessionId: id, branch: 'constructor' })).toMatchObject({ ok: true });
      expect(await currentBranch(main)).toBe('constructor');

      await rm(other, { recursive: true, force: true });
      expect(await service.updateProject({ sessionId: id, branch: 'feat/held' })).toMatchObject({
        ok: false,
        elsewhere: { branch: 'feat/held', path: other, prunable: true },
      });
    });

    it('offers both ways on: moving into that checkout, or a worktree with it as the base', async () => {
      const { main, other } = await heldElsewhere('held-use');
      const before = await listWorktrees(main);

      const moved = await codeSession(main);
      expect(
        await service.updateProject({ sessionId: moved, directory: other, branch: 'feat/held', workspace: false })
      ).toMatchObject({ ok: true });
      expect((await service.getSession(moved))?.project).toMatchObject({
        directory: other,
        workingDirectory: other,
        branch: 'feat/held',
        workspace: false,
      });
      expect(await listWorktrees(main)).toEqual(before);

      const cut = await codeSession(main);
      expect(await service.updateProject({ sessionId: cut, branch: 'feat/held', workspace: true })).toMatchObject({
        ok: true,
      });
      expect((await service.getSession(cut))?.project).toMatchObject({
        branch: 'feat/held',
        workspace: true,
        workingDirectory: main,
      });

      // Picked as a base once the toggle is already on, with no refusal either.
      const toggled = await codeSession(main);
      await service.updateProject({ sessionId: toggled, workspace: true });
      expect(await service.updateProject({ sessionId: toggled, branch: 'feat/held' })).toMatchObject({ ok: true });
      expect(await currentBranch(main)).toBe('main');
    });
  });

  it("reports any other refused switch without git's fatal: tag", async () => {
    const { main } = await repository('off-clash');
    await git(main, ['switch', '--quiet', '-c', 'feat/x']);
    await writeFile(join(main, 'clash.txt'), 'tracked on feat/x\n', 'utf8');
    await git(main, ['add', 'clash.txt']);
    await git(main, ['commit', '--quiet', '-m', 'clash']);
    await git(main, ['switch', '--quiet', 'main']);
    await writeFile(join(main, 'clash.txt'), 'untracked on main\n', 'utf8');
    const id = await codeSession(main);

    const result = await service.updateProject({ sessionId: id, branch: 'feat/x' });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/^Could not switch .* to feat\/x: /);
    expect(result.ok === false && result.error).not.toMatch(/fatal:|error:|hint:/i);
  });

  it('refuses while a background process is alive in the working directory, but not once it has exited', async () => {
    const { main } = await repository('gamma');
    const id = await codeSession(main);
    running = [{ command: 'pnpm dev', status: 'running' } as BackgroundProcessInfo];

    const result = await service.updateProject({ sessionId: id, branch: 'feat/chips', workspace: true });

    expect(result).toMatchObject({ ok: false, busy: true });
    expect(result.ok === false && result.error).toContain('pnpm dev');
    // The refusal must leave the binding untouched, or the session would claim a worktree it
    // never moved to while the process kept running in the old one.
    expect((await service.getSession(id))?.project).toMatchObject({ workspace: false, workingDirectory: main });

    running = [{ command: 'pnpm build', status: 'exited' } as BackgroundProcessInfo];
    expect(await service.updateProject({ sessionId: id, branch: 'feat/chips', workspace: true })).toMatchObject({
      ok: true,
    });
  });

  it('moving to another repository drops the old branch and context folders', async () => {
    const first = await repository('epsilon');
    const second = await repository('zeta');
    const id = await codeSession(first.main);
    await service.shareDirectory(id, first.container);

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
  it('refuses the worktree container as a project, on create and on update, and points at the checkouts inside', async () => {
    const { container, main } = await repository('gamma');

    const created = await service.createCodeSession({ directory: container, branch: '', workspace: false });
    expect(created).toMatchObject({ ok: false });
    expect(created.ok === false && created.error).toMatch(/not a checkout/i);

    const id = await codeSession(main);
    const result = await service.updateProject({ sessionId: id, directory: container });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/not a checkout/i);
    expect((await service.getSession(id))?.project).toMatchObject({ directory: main });
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
  it('binds with main as the base, or with the folder alone and no branch, and takes the base later', async () => {
    const { service, main } = await serviceOn();

    const result = await service.createCodeSession({ directory: main, branch: 'main', workspace: true });

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && (await service.getSession(result.session.id))?.project).toMatchObject({
      branch: 'main',
      workspace: true,
      workingDirectory: main,
    });

    const alone = await service.createCodeSession({ directory: main });

    expect(alone).toMatchObject({ ok: true });
    if (!alone.ok) return;
    expect((await service.getSession(alone.session.id))?.project).toMatchObject({
      directory: main,
      branch: '',
      workspace: false,
      workingDirectory: main,
      contextDirectories: [],
    });

    // The same choice made deliberately on the new session.
    expect(await service.updateProject({ sessionId: alone.session.id, branch: 'main', workspace: true })).toMatchObject(
      { ok: true }
    );
    expect((await service.getSession(alone.session.id))?.project?.workspace).toBe(true);
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

  /**
   * The branch is named after the prompt: the session is still called 'New chat' at this point,
   * which is what filled a container with b4m+new-chat-* folders. Reuse is the severe one at this
   * user's volume: a second turn that cut another branch would leave a worktree per message.
   */
  it('cuts the branch and the worktree when the first message is sent, and keeps them after', async () => {
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

    await service.send(id, 'second');
    const kept = { workspaceBranch: project?.workspaceBranch, workingDirectory: project?.workingDirectory };
    expect((await service.getSession(id))?.project, 'a later turn').toMatchObject(kept);
    expect((await listWorktrees(main)).filter(entry => entry.branch?.startsWith('b4m/'))).toHaveLength(1);

    await service.updateProject({ sessionId: id, branch: 'main', workspace: true });
    expect((await service.getSession(id))?.project, 'a change not about the base').toMatchObject(kept);
  });

  it('cuts a new branch from a base another worktree holds, leaving that checkout alone', async () => {
    const { container, main } = await repository('turn-held');
    const other = join(container, 'feat+held');
    await git(main, ['worktree', 'add', '--quiet', '-b', 'feat/held', other]);
    const id = await bound(main, 'main');
    await service.updateProject({ sessionId: id, branch: 'feat/held', workspace: true });

    await service.send(id, 'Fix the login form');

    const project = (await service.getSession(id))?.project;
    expect(project?.workspaceBranch).toMatch(/^b4m\//);
    expect(project?.workingDirectory).not.toBe(other);
    expect(await currentBranch(other)).toBe('feat/held');
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
    // Bound per test: a previous service replying late must not push into this test's events.
    const emitted: ChatStreamEvent[] = [];
    events = emitted;
    queueEvents = [];
    onEvent = () => undefined;
    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => ({}) as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => {
        emitted.push(event);
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

  it('opens, names the branch, and closes before the reply starts, and says nothing on the next turn', async () => {
    const { main } = await repository('status-first');
    const id = await bound(main, 'main');

    await service.send(id, 'Fix the login form');

    const branch = (await service.getSession(id))?.project?.workspaceBranch;
    expect(workspaceEvents()).toEqual([
      { type: 'workspace', sessionId: id, seq: expect.any(Number), running: true, base: 'main' },
      { type: 'workspace', sessionId: id, seq: expect.any(Number), running: true, base: 'main', branch },
      { type: 'workspace', sessionId: id, seq: expect.any(Number), running: false, base: 'main' },
    ]);
    const closed = events.findIndex(event => event.type === 'workspace' && !event.running);
    expect(events.findIndex(event => event.type === 'start')).toBeGreaterThan(closed);

    events.length = 0;
    await service.send(id, 'second');
    expect(workspaceEvents()).toEqual([]);
  });

  it('runs in the project directory, creates nothing and says nothing with the worktree toggle off', async () => {
    const { main } = await repository('status-off');
    const created = await service.createCodeSession({ directory: main, branch: 'main', workspace: false });
    if (!created.ok) throw new Error(created.error);
    const before = await listWorktrees(main);

    await service.send(created.session.id, 'do the thing');

    expect((await service.getSession(created.session.id))?.project?.workingDirectory).toBe(main);
    expect(await listWorktrees(main)).toEqual(before);
    expect(workspaceEvents()).toEqual([]);
  });

  /**
   * The refusal moved with the creation: it reaches the user as the turn being turned away,
   * which is where they are looking, rather than minutes earlier on a toggle.
   */
  it('refuses the turn when the worktree cannot be made, closes, stores no prompt, and hands back what was typed meanwhile', async () => {
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
    expect(sent.ok === false && sent.error).toMatch(/already exists but is not a git worktree/);
    expect(await typedAhead).toMatchObject({ ok: true, queued: true });
    await vi.waitFor(() => expect(queueEvents.some(event => event.returned?.reason === 'refused')).toBe(true), {
      interval: 5,
    });
    expect(workspaceEvents().at(-1)).toMatchObject({ running: false });
    expect(service.isSessionBusy(id)).toBe(false);
    expect((await store.get(id))?.messages ?? []).toHaveLength(0);
    expect((await service.getSession(id))?.project?.workingDirectory).toBe(main);
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

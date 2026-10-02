import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackgroundProcessInfo } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import { git } from './project/git';
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
      background: { list: () => running } as unknown as BackgroundProcessRegistry,
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

  it('turning the worktree on moves the working directory into the container', async () => {
    const { container, main } = await repository('alpha');
    const id = await codeSession(main);

    const result = await service.updateProject({ sessionId: id, branch: 'feat/chips', workspace: true });

    expect(result).toMatchObject({ ok: true });
    const project = (await service.getSession(id))?.project;
    expect(project).toMatchObject({
      branch: 'feat/chips',
      workspace: true,
      workingDirectory: join(container, 'feat+chips'),
    });
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

  it('leaves the session alone when the worktree cannot be prepared', async () => {
    const { container, main } = await repository('eta');
    await mkdir(join(container, 'feat+chips'), { recursive: true });

    const id = await codeSession(main);
    const result = await service.updateProject({ sessionId: id, branch: 'feat/chips', workspace: true });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.busy).toBeFalsy();
    expect((await service.getSession(id))?.project).toMatchObject({ workspace: false, workingDirectory: main });
  });

  it('refuses a Chat session, which has no project to re-ground', async () => {
    const { id } = await service.createSession();

    expect(await service.updateProject({ sessionId: id })).toMatchObject({ ok: false });
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

  it('fails when the sibling binding is carried across', async () => {
    const { service, main } = await serviceOn();

    const result = await service.createCodeSession({ directory: main, branch: 'main', workspace: true });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain('is a git worktree holding the branch');
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

  it('still refuses when the user picks that branch deliberately on the new session', async () => {
    const { service, main } = await serviceOn();
    const created = await service.createCodeSession({ directory: main });
    if (!created.ok) throw new Error(created.error);

    const result = await service.updateProject({ sessionId: created.session.id, branch: 'main', workspace: true });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain('is a git worktree holding the branch');
  });
});

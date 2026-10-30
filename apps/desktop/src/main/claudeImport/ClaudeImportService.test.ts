import { copyFile, mkdir, mkdtemp, readFile, writeFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession } from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';
import { SessionStore } from '../chat/SessionStore';
import * as chatImport from './ClaudeChatImport';
import { buildZip } from './__fixtures__/buildZip';
import { codeSessionId, importScopeTag } from './ClaudeCodeSync';
import { ClaudeImportService } from './ClaudeImportService';

const dialog = vi.hoisted(() => ({ next: null as string | null }));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: {
    showOpenDialog: async () =>
      dialog.next ? { canceled: false, filePaths: [dialog.next] } : { canceled: true, filePaths: [] },
  },
}));

const FIXTURES = join(__dirname, '__fixtures__');
const SOURCE_ID = '11111111-2222-4333-8444-555555555555';
const SESSION_ID = codeSessionId(SOURCE_ID, undefined, importScopeTag('test-scope'));

let services: ClaudeImportService[] = [];
afterEach(() => {
  for (const service of services) service.dispose();
  services = [];
  dialog.next = null;
  vi.useRealTimers();
});

async function setup(
  options: {
    signedIn?: boolean;
    scopeKey?: () => string | null;
    beforeList?: () => void;
    beforeDelete?: () => Promise<void>;
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'claude-import-service-'));
  const home = join(root, 'home');
  const project = join(home, '.claude', 'projects', '-work-example-project');
  await mkdir(project, { recursive: true });
  await copyFile(join(FIXTURES, 'code-session.jsonl'), join(project, `${SOURCE_ID}.jsonl`));
  const store = new SessionStore(join(root, 'sessions'), 'default-model');
  const sent: string[] = [];
  let picked: string | null = null;
  const deleted: string[] = [];
  const service = new ClaudeImportService({
    home,
    userData: join(root, 'userData'),
    store,
    scopeKey: options.scopeKey ?? (() => (options.signedIn === false ? null : 'test-scope')),
    pickModel: async () => 'picked-model',
    listSessions: async () => {
      options.beforeList?.();
      return store.list();
    },
    deleteImported: async (id, scopeKey) => {
      await options.beforeDelete?.();
      const outcome = await store.deleteImported(id, scopeKey);
      if (outcome === 'removed') deleted.push(id);
      return outcome;
    },
    pickPath: async () => picked,
    send: channel => sent.push(channel),
    logger: { warn: () => {} },
  });
  services.push(service);
  return { root, home, store, service, sent, deleted, pick: (path: string | null) => (picked = path) };
}

/**
 * Drops an export into the watched folder after the watch began. Linux stamps mtimes from a coarse
 * clock that can trail Date.now() by a millisecond or so, so a file written moments after
 * setChatWatchFolder could read as older than the watch and be skipped; stamp it clearly after.
 */
async function writeWatchedExport(path: string, data: string | Buffer): Promise<void> {
  await writeFile(path, data);
  const arrived = new Date(Date.now() + 1000);
  await utimes(path, arrived, arrived);
}

describe('ClaudeImportService', () => {
  it('syncs the default folder, counts what it found, and tells the sidebar once', async () => {
    const { service, store, sent } = await setup();
    await service.syncCode();
    const state = await service.state();
    expect(state.code.counts).toEqual({ found: 1, imported: 1, skipped: 0, failed: 0 });
    expect(state.code.projects).toEqual([{ cwd: '/work/example-project', name: 'example-project', sessions: 1 }]);
    expect(state.code.lastSyncAt).not.toBeNull();
    expect((await store.get(SESSION_ID))?.title).toBe('Sample listing session');
    await vi.waitUntil(() => sent.includes(IPC_CHANNELS.claudeImportedSessionsChanged), { timeout: 3000 });
    expect(sent.filter(channel => channel === IPC_CHANNELS.claudeImportedSessionsChanged)).toHaveLength(1);
  });

  it('does nothing while signed out', async () => {
    const { service, store } = await setup({ signedIn: false });
    await service.syncCode();
    expect(await store.list()).toEqual([]);
    expect((await service.state()).signedIn).toBe(false);
    expect(await service.importChatExport()).toEqual({ ok: true, state: expect.anything() });
  });

  it('takes only booleans and project folders the index has seen from the renderer', async () => {
    const { service } = await setup();
    await service.syncCode();
    let state = await service.setCodeSettings({
      enabled: 'yes',
      includeSubagents: 1,
      projects: ['/etc', '/work/example-project', 42],
    });
    expect(state.code.settings).toEqual({
      enabled: false,
      sourceFolder: null,
      projects: ['/work/example-project'],
      includeSubagents: false,
    });
    state = await service.setCodeSettings({ sourceFolder: '/etc' });
    expect(state.code.settings.sourceFolder).toBeNull();
    state = await service.setCodeSettings({ projects: 'all' });
    expect(state.code.settings.projects).toBe('all');
  });

  it('does not import on a filter change while sync is off', async () => {
    const { service, store } = await setup();
    await service.setCodeSettings({ includeSubagents: true });
    await service.setCodeSettings({ projects: 'all' });
    expect((await service.state()).code.running).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it('leaves out sessions run outside .claude/worktrees, and drops copies that leave the filter', async () => {
    const { home, service, store } = await setup();
    const elsewhere = '22222222-2222-4333-8444-555555555555';
    const fixture = await readFile(join(FIXTURES, 'code-session.jsonl'), 'utf8');
    await writeFile(
      join(home, '.claude', 'projects', '-work-example-project', `${elsewhere}.jsonl`),
      fixture.replaceAll(
        '/work/example-project/.claude/worktrees/sample',
        '/work/example-project/.manifold/worktrees/run'
      )
    );
    await service.setCodeSettings({ enabled: true });
    await service.syncCode();
    expect((await service.state()).code.counts).toMatchObject({ found: 1, imported: 1 });
    expect((await store.list()).map(session => session.id)).toEqual([SESSION_ID]);

    await service.setCodeSettings({ projects: [] });
    await service.syncCode();
    expect(await store.list()).toEqual([]);
    await service.setCodeSettings({ projects: 'all' });
    await service.syncCode();
    expect((await store.list()).map(session => session.id)).toEqual([SESSION_ID]);
  });

  it('re-files and prunes existing copies at launch, with sync off', async () => {
    const { root, service, store } = await setup();
    const repository = join(root, 'repo');
    const worktree = join(repository, '.claude', 'worktrees', 'wt');
    await mkdir(worktree, { recursive: true });
    await mkdir(join(repository, '.manifold', 'worktrees', 'run'), { recursive: true });
    const copy = (id: string, cwd: string, extra: Partial<ChatSession['importOrigin']> = {}): ChatSession => ({
      id,
      title: id,
      model: 'm',
      createdAt: 'x',
      updatedAt: 'x',
      mode: 'code',
      approvalMode: 'ask',
      reasoningEffort: 'default',
      project: {
        directory: cwd,
        name: 'old',
        branch: 'b',
        workspace: false,
        workingDirectory: cwd,
        contextDirectories: [],
      },
      importOrigin: {
        kind: 'claude-code',
        sourceId: id,
        importedAt: 'x',
        sourceUpdatedAt: 'x',
        cwd,
        gitBranch: 'b',
        ...extra,
      },
      messages: [{ id: 'cc-1', role: 'user', content: 'hi', createdAt: 'x' }],
    });
    await store.putImported(copy('cc-in', worktree));
    await store.putImported(copy('cc-out', join(repository, '.manifold', 'worktrees', 'run')));
    await store.putImported(copy('cc-kept', join(repository, '.manifold', 'worktrees', 'run'), { forkedAt: 'x' }));
    await store.putImported(copy('cca-agent', worktree, { parentSourceId: 'cc-in' }));

    service.onScopeChanged();
    await vi.waitUntil(async () => (await store.get('cc-out')) === null, { timeout: 3000 });
    expect((await store.list()).map(session => session.id).sort()).toEqual(['cc-in', 'cc-kept']);
    expect((await store.get('cc-in'))!.project).toMatchObject({
      directory: repository,
      name: 'repo',
      workspace: true,
      workspaceBranch: 'b',
      workingDirectory: worktree,
    });
    expect((await service.state()).code.settings.enabled).toBe(false);
  });

  it('filters by project', async () => {
    const { service, store } = await setup();
    await service.syncCode();
    await service.removeImported('claude-code');
    await service.setCodeSettings({ projects: [] });
    await service.syncCode();
    const state = await service.state();
    expect(state.code.counts.found).toBe(0);
    expect(await store.get(SESSION_ID)).toBeNull();
  });

  it('removes only desktop copies that were not continued, and turns sync off', async () => {
    const { service, store, deleted } = await setup();
    await service.setCodeSettings({ enabled: true });
    await service.syncCode();
    await expect(service.removeImported('everything')).rejects.toThrow(/unknown import source/);

    await store.putImported({
      id: 'cc-other',
      title: 'Other',
      model: 'm',
      createdAt: 'x',
      updatedAt: 'x',
      mode: 'code',
      approvalMode: 'ask',
      reasoningEffort: 'default',
      importOrigin: { kind: 'claude-code', sourceId: 'other', importedAt: 'x', sourceUpdatedAt: 'x' },
      messages: [{ id: 'cc-1', role: 'user', content: 'hi', createdAt: 'x' }],
    });
    await store.appendMessage('cc-other', { id: 'mine', role: 'user', content: 'continued', createdAt: 'x' });

    const result = await service.removeImported('claude-code');
    expect(result).toEqual({ removed: 1, keptForked: 1 });
    expect(deleted).toEqual([SESSION_ID]);
    expect(await store.get('cc-other')).not.toBeNull();
    expect((await service.state()).code.settings.enabled).toBe(false);
  });

  it('imports a picked export and records the summary', async () => {
    const { root, service, store, pick } = await setup();
    const path = join(root, 'conversations.json');
    await copyFile(join(FIXTURES, 'conversations.json'), path);
    pick(path);
    const result = await service.importChatExport();
    expect(result.ok).toBe(true);
    const state = (await service.state()).chat;
    expect(state.lastImport).toMatchObject({ fileName: 'conversations.json', counts: { imported: 2 } });
    expect((await store.list()).filter(session => session.importOrigin?.kind === 'claude-chat')).toHaveLength(2);
  });

  it('aborts removal when the account changes while listing sessions', async () => {
    let scope = 'test-scope';
    let switchOnList = false;
    const { service, store, deleted } = await setup({
      scopeKey: () => scope,
      beforeList: () => {
        if (switchOnList) scope = 'other-scope';
      },
    });
    await service.syncCode();
    switchOnList = true;
    await expect(service.removeImported('claude-code')).rejects.toThrow(/account changed/);
    expect(deleted).toEqual([]);
    expect(await store.get(SESSION_ID)).not.toBeNull();
  });

  it('keeps a session continued after the removal list was captured', async () => {
    const { service, store, deleted } = await setup({
      beforeDelete: async () => {
        await store.appendMessage(SESSION_ID, { id: 'new-turn', role: 'user', content: 'keep me', createdAt: 'x' });
      },
    });
    await service.syncCode();
    expect(await service.removeImported('claude-code')).toEqual({ removed: 0, keptForked: 1 });
    expect(deleted).toEqual([]);
    expect((await store.get(SESSION_ID))?.messages.at(-1)?.content).toBe('keep me');
    expect((await service.state()).code.forked).toBe(1);
  });

  it('retries an unchanged watched export after a failed conversation write', async () => {
    vi.useFakeTimers();
    const { root, service, store, pick } = await setup();
    const folder = join(root, 'downloads');
    await mkdir(folder);
    pick(folder);
    await service.setChatWatchFolder(false);
    const fixture = JSON.parse(await readFile(join(FIXTURES, 'conversations.json'), 'utf8')) as unknown[];
    const path = join(folder, 'export.zip');
    await writeWatchedExport(
      path,
      buildZip([
        { name: 'users.json', data: Buffer.from('[]') },
        { name: 'conversations.json', data: Buffer.from(JSON.stringify([fixture[0]])) },
      ])
    );
    const write = vi.spyOn(store, 'putImported').mockRejectedValueOnce(new Error('EIO'));
    service.start();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(async () => expect((await service.state()).chat.lastImport?.counts.failed).toBe(1));
    const original = await stat(path);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => expect((await service.state()).chat.lastImport?.counts.imported).toBe(1));
    expect(write).toHaveBeenCalledTimes(2);
    expect((await stat(path)).mtimeMs).toBe(original.mtimeMs);
  });

  it('does not retry a watched export whose only failure is an unreadable conversation', async () => {
    vi.useFakeTimers();
    const { root, service, pick } = await setup();
    const folder = join(root, 'downloads');
    await mkdir(folder);
    pick(folder);
    await service.setChatWatchFolder(false);
    const fixture = JSON.parse(await readFile(join(FIXTURES, 'conversations.json'), 'utf8')) as unknown[];
    const path = join(folder, 'export.zip');
    await writeWatchedExport(
      path,
      buildZip([
        { name: 'users.json', data: Buffer.from('[]') },
        { name: 'conversations.json', data: Buffer.from(JSON.stringify([fixture[0], { not: 'a conversation' }])) },
      ])
    );
    service.start();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(async () => {
      const scope = JSON.parse(await readFile(join(root, 'userData', 'claude-import', 'test-scope.json'), 'utf8'));
      expect(scope.watchedSeen[path]).toBe((await stat(path)).mtimeMs);
    });
    expect((await service.state()).chat.lastImport?.counts).toMatchObject({ imported: 1, failed: 1 });
  });

  it('retries an archive that was unreadable on the initial scan at the same mtime', async () => {
    vi.useFakeTimers();
    const { root, service, store, pick } = await setup();
    const folder = join(root, 'downloads');
    await mkdir(folder);
    pick(folder);
    await service.setChatWatchFolder(false);
    const path = join(folder, 'export.zip');
    await writeWatchedExport(path, 'not a complete zip archive yet');
    const original = await stat(path);
    service.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await service.state()).chat.lastImport).toBeNull();
    const fixture = JSON.parse(await readFile(join(FIXTURES, 'conversations.json'), 'utf8')) as unknown[];
    await writeFile(
      path,
      buildZip([
        { name: 'users.json', data: Buffer.from('[]') },
        { name: 'conversations.json', data: Buffer.from(JSON.stringify([fixture[0]])) },
      ])
    );
    await utimes(path, original.atime, original.mtime);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () =>
      expect((await store.list()).filter(session => session.importOrigin?.kind === 'claude-chat')).toHaveLength(1)
    );
  });

  it('does not import a watched export after its account signs out during recognition', async () => {
    vi.useFakeTimers();
    let scope: string | null = 'test-scope';
    const { root, service, store, pick } = await setup({ scopeKey: () => scope });
    const folder = join(root, 'downloads');
    await mkdir(folder);
    pick(folder);
    await service.setChatWatchFolder(false);
    await writeWatchedExport(join(folder, 'export.zip'), 'recognition is stubbed');
    const recognition = vi.spyOn(chatImport, 'looksLikeClaudeExport').mockImplementationOnce(async () => {
      scope = null;
      return true;
    });
    try {
      service.start();
      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(recognition).toHaveBeenCalled());
      expect((await service.state()).chat.lastImport).toBeNull();
      expect(await store.list()).toEqual([]);
    } finally {
      recognition.mockRestore();
    }
  });

  it('reports a picked folder that is not there', async () => {
    const { root, service, pick } = await setup();
    pick(join(root, 'missing'));
    await service.pickCodeFolder(false);
    await service.syncCode();
    const state = await service.state();
    expect(state.code.sourceFolder).toBe(join(root, 'missing'));
    expect(state.code.error).toBe('The source folder does not exist.');
    expect((await service.pickCodeFolder(true)).code.sourceFolder).toMatch(/home[\\/]\.claude[\\/]projects$/);
  });
});

describe('registerClaudeImport', () => {
  it('registers channels that take no path, and drops a picked file that is not an export', async () => {
    const { registerClaudeImport } = await import('./index');
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const root = await mkdtemp(join(tmpdir(), 'claude-import-ipc-'));
    const store = new SessionStore(join(root, 'sessions'), 'default-model');
    const service = registerClaudeImport(
      {
        handle: (channel: string, handler: (event: never, ...args: never[]) => unknown) =>
          void handlers.set(channel, handler as (...args: unknown[]) => unknown),
      },
      {
        home: join(root, 'home'),
        userData: join(root, 'userData'),
        store,
        scopeKey: () => 'test-scope',
        pickModel: async () => undefined,
        listSessions: () => store.list(),
        deleteImported: async () => 'missing',
        send: () => {},
        logger: { warn: () => {} },
      }
    );
    services.push(service);
    expect([...handlers.keys()].sort()).toEqual(
      [
        IPC_CHANNELS.claudeImportGetState,
        IPC_CHANNELS.claudeImportSetCodeSettings,
        IPC_CHANNELS.claudeImportPickCodeFolder,
        IPC_CHANNELS.claudeImportSyncCode,
        IPC_CHANNELS.claudeImportChatExport,
        IPC_CHANNELS.claudeImportSetWatchFolder,
        IPC_CHANNELS.claudeImportRemove,
      ].sort()
    );

    const notAnExport = join(root, 'secrets.txt');
    await writeFile(notAnExport, 'private');
    dialog.next = notAnExport;
    const event = { sender: {} };
    const result = (await handlers.get(IPC_CHANNELS.claudeImportChatExport)!(event)) as {
      ok: boolean;
      state: { chat: { lastImport: unknown } };
    };
    expect(result.ok).toBe(true);
    expect(result.state.chat.lastImport).toBeNull();

    // A renderer passing a path where a flag belongs gets the flag's meaning, never the path.
    dialog.next = null;
    const state = (await handlers.get(IPC_CHANNELS.claudeImportPickCodeFolder)!(event, '/etc')) as {
      code: { settings: { sourceFolder: string | null } };
    };
    expect(state.code.settings.sourceFolder).toBeNull();
  });
});

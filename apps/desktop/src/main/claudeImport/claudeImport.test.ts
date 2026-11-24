import { copyFile, mkdir, mkdtemp, readFile, writeFile, stat, utimes, appendFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi, onTestFinished } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { SessionStore } from '../chat/SessionStore';
import { buildZip } from './__fixtures__/buildZip';
import {
  codeSessionId,
  importScopeTag,
  countsFor,
  importTranscript,
  listTranscripts,
  claudeWorktreeOf,
  CODE_MAP_VERSION,
  matchesFilter,
  needsImport,
  peekTranscript,
  projectFor,
  type IndexedTranscript,
} from './ClaudeCodeSync';
import { ClaudeImportService } from './ClaudeImportService';
import { sessionScopeKey, type SessionScope } from '../chat/sessionScope';
import { fetchQuests, listWebNotebooks, webSessionId, type WebApi } from './WebSessionSync';
import { AttachmentStore } from '../chat/AttachmentStore';
import { mapToolCall, applyCodeEvent, tidyMessages, type CodeMapState } from './claudeCodeMapper';
import { activeTodos } from '@shared/todos';
import * as chatImport from './ClaudeChatImport';
import { chatSessionId, importChatExport, looksLikeClaudeExport } from './ClaudeChatImport';
import {
  IMPORTED_COMPACT_CHARS,
  importedHistoryNeedsCompaction,
  importedTurnAsText,
  isImportedToolTurn,
} from './continuation';
import { isImportedMessageId, normalizeImportOrigin } from '@shared/claudeImport';
import { mapQuests, readNotebook } from './webSessionMapper';
import { DEFAULT_SETTINGS, ImportStateStore, type FileCursor } from './ImportStateStore';
import { Readable } from 'node:stream';
import { streamJsonArray } from './jsonArrayStream';
import { readHeadAndTail, readJsonlLines } from './jsonlLines';
import { isUnsafeMemberName, listZipMembers, readZipMember, ZipError } from './zipReader';
import type { ChatSession, ChatMessage } from '@shared/chat';

// Conditions here hold a few promise turns in; vi.waitFor's default 50ms poll would wait each one out.
// Under fake timers each poll also advances the clock by its interval, so those keep the default.
const waitFor = <T>(check: () => T | Promise<T>, options: { timeout?: number; interval?: number } = {}) =>
  vi.waitFor(check, { ...(vi.isFakeTimers() ? {} : { interval: 1 }), ...options });

const dialog = vi.hoisted(() => ({ next: null as string | null }));
// Both pass through to the real module until a test arms them.
const slowRead = vi.hoisted(() => ({ gate: null as Promise<void> | null }));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      const gate = slowRead.gate;
      const contents = await actual.readFile(...args);
      if (gate) await gate;
      return contents;
    }) as typeof actual.readFile,
  };
});

const readFailure = vi.hoisted(() => ({ next: null as Error | null }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    createReadStream: (...args: Parameters<typeof fs.createReadStream>) => {
      const error = readFailure.next;
      if (!error) return fs.createReadStream(...args);
      readFailure.next = null;
      return new Readable({
        read() {
          this.destroy(error);
        },
      });
    },
  };
});

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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { service, store, sent } = await setup();
    await service.syncCode();
    const state = await service.state();
    expect(state.code.counts).toEqual({ found: 1, imported: 1, skipped: 0, failed: 0 });
    expect(state.code.projects).toEqual([{ cwd: '/work/example-project', name: 'example-project', sessions: 1 }]);
    expect(state.code.lastSyncAt).not.toBeNull();
    expect((await store.get(SESSION_ID))?.title).toBe('Sample listing session');
    await vi.advanceTimersByTimeAsync(3000);
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
    await waitFor(async () => expect((await service.state()).chat.lastImport?.counts.failed).toBe(1));
    const original = await stat(path);
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(async () => expect((await service.state()).chat.lastImport?.counts.imported).toBe(1));
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
    await waitFor(async () => {
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
    await waitFor(async () =>
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
      await waitFor(() => expect(recognition).toHaveBeenCalled());
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
        IPC_CHANNELS.claudeImportSetWebSettings,
        IPC_CHANNELS.claudeImportSyncWeb,
        IPC_CHANNELS.claudeImportDismissHint,
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

describe('sync hints', () => {
  async function hintSetup(options: { notebooks?: number; countFails?: { times: number } } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'claude-import-hints-'));
    const home = join(root, 'home');
    const projects = join(home, '.claude', 'projects');
    const files: [string, string][] = [
      ['-work-repo--claude-worktrees-one', SOURCE_ID],
      ['-work-repo', '99999999-2222-4333-8444-555555555555'],
    ];
    for (const [folder, id] of files) {
      await mkdir(join(projects, folder), { recursive: true });
      await writeFile(join(projects, folder, `${id}.jsonl`), 'not read for a hint', 'utf8');
    }
    const get = vi.fn(async (url: string) => {
      if (url === '/api/sessions/count') {
        if (options.countFails && options.countFails.times-- > 0) throw new Error('offline');
        return { count: options.notebooks ?? 4 };
      }
      throw new Error(`unexpected ${url}`);
    });
    const userData = join(root, 'userData');
    const warn = vi.fn();
    const make = () => {
      const store = new SessionStore(join(root, 'sessions'), 'default-model');
      const service = new ClaudeImportService({
        home,
        userData,
        store,
        scopeKey: () => 'test-scope',
        pickModel: async () => undefined,
        listSessions: () => store.list(),
        deleteImported: async () => 'missing',
        pickPath: async () => null,
        send: () => {},
        logger: { warn },
        webApi: () => ({ get: get as <T>(url: string) => Promise<T> }),
      });
      services.push(service);
      return service;
    };
    return { service: make(), get, make, warn };
  }

  it('counts Claude worktree sessions by name and the web notebooks with one request', async () => {
    const { service, get } = await hintSetup();
    service.onScopeChanged();
    await waitFor(async () => expect((await service.state()).hints.webNotebooks).toBe(4));
    const { hints } = await service.state();
    expect(hints.codeSessions).toBe(1);
    expect(get).toHaveBeenCalledTimes(1);
    service.onScopeChanged();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('keeps the Claude Code count when the web count fails, and retries it on focus', async () => {
    const { service, get, warn } = await hintSetup({ countFails: { times: 1 } });
    service.onScopeChanged();
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    const { hints } = await service.state();
    expect(hints.codeSessions).toBe(1);
    expect(hints.webNotebooks).toBeNull();
    service.onWindowFocus();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(get).toHaveBeenCalledTimes(1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    service.onWindowFocus();
    await waitFor(async () => expect((await service.state()).hints.webNotebooks).toBe(4));
    vi.useRealTimers();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('skips the session listing and the web count once the empty-sidebar card is dismissed', async () => {
    const { service, get } = await hintSetup();
    await service.dismissHint('sidebar-empty');
    service.onScopeChanged();
    await new Promise(resolve => setTimeout(resolve, 50));
    const { hints } = await service.state();
    expect(get).not.toHaveBeenCalled();
    expect(hints.webNotebooks).toBeNull();
    expect(hints.codeSessions).not.toBe(1);
  });

  it('keeps a dismissal for the account across a restart, and ignores unknown ids', async () => {
    const { service, make } = await hintSetup();
    expect((await service.dismissHint('claude-code')).hints.dismissed).toEqual(['claude-code']);
    expect((await service.dismissHint('tour')).hints.dismissed).toEqual(['claude-code']);
    expect((await make().state()).hints.dismissed).toEqual(['claude-code']);
  });
});

describe('web session sync', () => {
  interface FakeNotebook {
    name: string;
    updatedAt: string;
    quests: { id: string; prompt: string; reply?: string; status?: string }[];
  }

  /** The two list routes the sync reads, paged the way the server pages them. */
  function fakeWeb(notebooks: Record<string, FakeNotebook>) {
    const get = vi.fn(async (url: string): Promise<unknown> => {
      const parsed = new URL(url, 'https://web.test');
      const page = Number(parsed.searchParams.get('pagination[page]'));
      const limit = Number(parsed.searchParams.get('pagination[limit]'));
      const slice = <T>(rows: T[]) => ({
        data: rows.slice((page - 1) * limit, page * limit),
        hasMore: rows.length > page * limit,
      });
      const chat = /^\/api\/sessions\/([^/]+)\/chat$/.exec(parsed.pathname);
      if (chat) {
        const notebook = notebooks[decodeURIComponent(chat[1])];
        if (!notebook) throw new Error('Session not found');
        return slice(notebook.quests.map(quest => ({ type: 'message', timestamp: notebook.updatedAt, ...quest })));
      }
      if (parsed.pathname === '/api/sessions') {
        return slice(Object.entries(notebooks).map(([id, notebook]) => ({ id, ...notebook })));
      }
      const detail = /^\/api\/sessions\/([^/]+)$/.exec(parsed.pathname);
      if (detail) {
        const id = decodeURIComponent(detail[1]);
        if (notebooks[id]) return { id, ...notebooks[id] };
        throw Object.assign(new Error('Session not found'), { isAxiosError: true, response: { status: 404 } });
      }
      throw new Error(`unexpected ${url}`);
    });
    return { notebooks, get, api: { get } as unknown as WebApi };
  }

  const ACCOUNT_A: SessionScope = { environmentUrl: 'https://web.test', accountId: 'account-a' };
  const ACCOUNT_B: SessionScope = { environmentUrl: 'https://web.test', accountId: 'account-b' };

  let services: ClaudeImportService[] = [];
  afterEach(() => {
    for (const service of services) service.dispose();
    services = [];
  });

  async function setup(apis: Map<string, WebApi>, initial: SessionScope | null = ACCOUNT_A) {
    const root = await mkdtemp(join(tmpdir(), 'web-session-sync-'));
    let scope = initial;
    const store = new SessionStore(join(root, 'sessions'), 'default-model', undefined, () => scope);
    const send = vi.fn();
    const service = new ClaudeImportService({
      home: join(root, 'home'),
      userData: join(root, 'userData'),
      store,
      scopeKey: () => (scope ? sessionScopeKey(scope) : null),
      pickModel: async () => 'picked-model',
      listSessions: () => store.list(),
      deleteImported: (id, scopeKey) => store.deleteImported(id, scopeKey),
      pickPath: async () => null,
      send,
      logger: { warn: () => {} },
      webApi: () => (scope ? (apis.get(scope.accountId) ?? null) : null),
    });
    services.push(service);
    return {
      store,
      service,
      send,
      signIn: (next: SessionScope | null) => {
        scope = next;
        service.onScopeChanged();
      },
    };
  }

  const idFor = (scope: SessionScope, notebookId: string) =>
    webSessionId(notebookId, importScopeTag(sessionScopeKey(scope)));

  function oneNotebook(): Record<string, FakeNotebook> {
    return {
      nb1: {
        name: 'Trip plan',
        updatedAt: '2026-01-01T00:00:00.000Z',
        quests: [{ id: 'q1', prompt: 'Where to?', reply: 'Lisbon' }],
      },
    };
  }

  describe('Bike4Mind web sync', () => {
    it('does nothing until enabled, then imports notebooks with a web origin', async () => {
      const web = fakeWeb(oneNotebook());
      const { service, store } = await setup(new Map([['account-a', web.api]]));
      await service.syncWeb();
      expect(web.get).not.toHaveBeenCalled();

      await service.setWebSettings({ enabled: true });
      await service.syncWeb();
      const session = await store.get(idFor(ACCOUNT_A, 'nb1'));
      expect(session?.title).toBe('Trip plan');
      expect(session?.importOrigin).toMatchObject({ kind: 'b4m-web', sourceId: 'nb1' });
      expect(session?.messages.map(message => message.content)).toEqual(['Where to?', 'Lisbon']);
      const state = await service.state();
      expect(state.web.counts).toEqual({ found: 1, imported: 1, skipped: 0, failed: 0 });
      expect(state.web.lastSyncAt).not.toBeNull();
    });

    it.each([null, {}, { message: 'unexpected' }, { data: [] }, { data: 'bad', hasMore: false }])(
      'rejects a malformed page rather than treating it as empty: %j',
      async payload => {
        const api = { get: async () => payload } as unknown as WebApi;
        await expect(listWebNotebooks(api)).rejects.toThrow();
        await expect(fetchQuests(api, 'nb1')).rejects.toThrow();
      }
    );

    it.each([[], { data: [], hasMore: false }])('accepts a valid empty page: %j', async payload => {
      const api = { get: async () => payload } as unknown as WebApi;
      await expect(listWebNotebooks(api)).resolves.toEqual({ notebooks: [], complete: true });
      await expect(fetchQuests(api, 'nb1')).resolves.toEqual({ quests: [], truncated: false });
    });

    it.each([null, {}, { id: '../invalid', prompt: 'bad' }])('rejects a malformed quest row: %j', async row => {
      const api = { get: async () => ({ data: [row], hasMore: false }) } as unknown as WebApi;
      await expect(fetchQuests(api, 'nb1')).rejects.toThrow('Invalid quest');
    });

    it('preserves copies and cursors when a successful response is malformed', async () => {
      const web = fakeWeb(oneNotebook());
      const { service, store } = await setup(new Map([['account-a', web.api]]));
      await service.setWebSettings({ enabled: true });
      await service.syncWeb();
      web.get.mockResolvedValueOnce({});
      await service.syncWeb();
      expect(await store.get(idFor(ACCOUNT_A, 'nb1'))).not.toBeNull();
      expect((await service.state()).web.error).toBeDefined();
      expect((await service.state()).web.counts.imported).toBe(1);
    });

    it('does not prune a live notebook omitted by an offset page', async () => {
      const web = fakeWeb(oneNotebook());
      const { service, store } = await setup(new Map([['account-a', web.api]]));
      await service.setWebSettings({ enabled: true });
      await service.syncWeb();
      web.get.mockResolvedValueOnce({ data: [], hasMore: false });
      await service.syncWeb();
      expect(await store.get(idFor(ACCOUNT_A, 'nb1'))).not.toBeNull();
      expect((await service.state()).web.counts.imported).toBe(1);
    });

    it('keeps a missing-list copy when its detail request fails', async () => {
      const web = fakeWeb(oneNotebook());
      const { service, store } = await setup(new Map([['account-a', web.api]]));
      await service.setWebSettings({ enabled: true });
      await service.syncWeb();
      web.get.mockResolvedValueOnce({ data: [], hasMore: false }).mockRejectedValueOnce(new Error('network down'));
      await service.syncWeb();
      expect(await store.get(idFor(ACCOUNT_A, 'nb1'))).not.toBeNull();
      expect((await service.state()).web.error).toContain('network down');
    });

    it('prunes an untouched copy even after its last refresh failed', async () => {
      const web = fakeWeb(oneNotebook());
      const { service, store } = await setup(new Map([['account-a', web.api]]));
      await service.setWebSettings({ enabled: true });
      await service.syncWeb();
      web.notebooks.nb1.updatedAt = '2026-01-02T00:00:00.000Z';
      web.get
        .mockResolvedValueOnce({ data: [{ id: 'nb1', ...web.notebooks.nb1 }], hasMore: false })
        .mockRejectedValueOnce(new Error('chat unavailable'));
      await service.syncWeb();
      expect((await service.state()).web.counts.failed).toBe(1);
      delete web.notebooks.nb1;
      await service.syncWeb();
      expect(await store.get(idFor(ACCOUNT_A, 'nb1'))).toBeNull();
      expect((await service.state()).web.counts.found).toBe(0);
    });

    it('refreshes rendered sessions when an emptied notebook is removed after a failed refresh', async () => {
      // Steps over the sidebar's 500ms debounce instead of waiting it out.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const web = fakeWeb(oneNotebook());
      const { service, store, send } = await setup(new Map([['account-a', web.api]]));
      await service.setWebSettings({ enabled: true });
      await service.syncWeb();
      await vi.advanceTimersByTimeAsync(500);
      expect(send).toHaveBeenCalledWith(IPC_CHANNELS.claudeImportedSessionsChanged, null);
      send.mockClear();

      web.notebooks.nb1.updatedAt = '2026-01-02T00:00:00.000Z';
      web.get
        .mockResolvedValueOnce({ data: [{ id: 'nb1', ...web.notebooks.nb1 }], hasMore: false })
        .mockRejectedValueOnce(new Error('chat unavailable'));
      await service.syncWeb();
      expect((await service.state()).web.counts.failed).toBe(1);
      expect(await store.get(idFor(ACCOUNT_A, 'nb1'))).not.toBeNull();

      web.notebooks.nb1.quests = [];
      await service.syncWeb();
      expect(await store.get(idFor(ACCOUNT_A, 'nb1'))).toBeNull();
      await vi.advanceTimersByTimeAsync(500);
      expect(send).toHaveBeenCalledWith(IPC_CHANNELS.claudeImportedSessionsChanged, null);
    });

    it('does not recreate a locally deleted copy after a failed refresh', async () => {
      const web = fakeWeb(oneNotebook());
      const { service, store } = await setup(new Map([['account-a', web.api]]));
      await service.setWebSettings({ enabled: true });
      await service.syncWeb();
      web.notebooks.nb1.updatedAt = '2026-01-02T00:00:00.000Z';
      web.get
        .mockResolvedValueOnce({ data: [{ id: 'nb1', ...web.notebooks.nb1 }], hasMore: false })
        .mockRejectedValueOnce(new Error('chat unavailable'));
      await service.syncWeb();
      await store.delete(idFor(ACCOUNT_A, 'nb1'));
      await service.syncWeb();
      expect(await store.get(idFor(ACCOUNT_A, 'nb1'))).toBeNull();
      expect((await service.state()).web.counts.found).toBe(0);
    });

    it('does not begin pruning after the toggle was turned off during listing', async () => {
      const web = fakeWeb(oneNotebook());
      const { service, store } = await setup(new Map([['account-a', web.api]]));
      await service.setWebSettings({ enabled: true });
      await service.syncWeb();
      let release!: () => void;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      web.get.mockImplementationOnce(async () => {
        await gate;
        return { data: [], hasMore: false };
      });
      web.get.mockClear();
      const run = service.syncWeb();
      await vi.waitFor(() => expect(web.get).toHaveBeenCalledTimes(1));
      await service.setWebSettings({ enabled: false });
      release();
      await run;
      expect(await store.get(idFor(ACCOUNT_A, 'nb1'))).not.toBeNull();
    });

    it('reads only changed notebooks, and appends new quests without duplicates', async () => {
      const web = fakeWeb({
        ...oneNotebook(),
        nb2: { name: 'Other', updatedAt: '2026-01-01T00:00:00.000Z', quests: [{ id: 'q9', prompt: 'x', reply: 'y' }] },
      });
      const { service, store } = await setup(new Map([['account-a', web.api]]));
      await service.setWebSettings({ enabled: true });
      await service.syncWeb();
      web.get.mockClear();

      await service.syncWeb();
      expect(web.get.mock.calls.map(([url]) => new URL(url, 'https://web.test').pathname)).toEqual(['/api/sessions']);

      web.notebooks.nb1.quests.push({ id: 'q2', prompt: 'When?', reply: 'May' });
      web.notebooks.nb1.updatedAt = '2026-01-02T00:00:00.000Z';
      web.get.mockClear();
      await service.syncWeb();
      const chatReads = web.get.mock.calls.map(([url]) => new URL(url, 'https://web.test').pathname);
      expect(chatReads).toEqual(['/api/sessions', '/api/sessions/nb1/chat']);
      const messages = (await store.get(idFor(ACCOUNT_A, 'nb1')))?.messages ?? [];
      expect(messages.map(message => message.id)).toEqual(['bw-q1-p', 'bw-q1-r', 'bw-q2-p', 'bw-q2-r']);
    });

    it('pages through long notebook lists and long notebooks', async () => {
      const notebooks: Record<string, FakeNotebook> = {};
      for (let index = 0; index < 205; index++) {
        notebooks[`nb${index}`] = { name: `Notebook ${index}`, updatedAt: '2026-01-01T00:00:00.000Z', quests: [] };
      }
      notebooks.nb0.quests = Array.from({ length: 150 }, (_, index) => ({ id: `q${index}`, prompt: `p${index}` }));
      const web = fakeWeb(notebooks);
      const { service, store } = await setup(new Map([['account-a', web.api]]));
      await service.setWebSettings({ enabled: true });
      await service.syncWeb();
      expect((await service.state()).web.counts.found).toBe(205);
      expect((await store.get(idFor(ACCOUNT_A, 'nb0')))?.messages).toHaveLength(150);
    });

    it('reads a notebook again while its reply was still running', async () => {
      const web = fakeWeb({
        nb1: {
          name: 'Live',
          updatedAt: '2026-01-01T00:00:00.000Z',
          quests: [{ id: 'q1', prompt: 'Go', status: 'running' }],
        },
      });
      const { service, store } = await setup(new Map([['account-a', web.api]]));
      await service.setWebSettings({ enabled: true });
      await service.syncWeb();
      web.notebooks.nb1.quests[0] = { id: 'q1', prompt: 'Go', reply: 'Done', status: 'done' };
      await service.syncWeb();
      expect((await store.get(idFor(ACCOUNT_A, 'nb1')))?.messages.map(message => message.content)).toEqual([
        'Go',
        'Done',
      ]);
    });

    it('never overwrites a session continued here', async () => {
      const web = fakeWeb(oneNotebook());
      const { service, store } = await setup(new Map([['account-a', web.api]]));
      await service.setWebSettings({ enabled: true });
      await service.syncWeb();
      const id = idFor(ACCOUNT_A, 'nb1');
      await store.appendMessage(id, { id: 'desktop-turn', role: 'user', content: 'mine', createdAt: 'x' });

      web.notebooks.nb1.quests.push({ id: 'q2', prompt: 'later on web', reply: 'r' });
      web.notebooks.nb1.updatedAt = '2026-01-05T00:00:00.000Z';
      await service.syncWeb();
      const session = await store.get(id);
      expect(session?.messages.map(message => message.content)).toEqual(['Where to?', 'Lisbon', 'mine']);
      expect(session?.importOrigin?.forkedAt).toBeTruthy();
      expect((await service.state()).web.forked).toBe(1);
    });

    it('removes an untouched copy when its notebook is deleted on the web', async () => {
      const web = fakeWeb(oneNotebook());
      const { service, store } = await setup(new Map([['account-a', web.api]]));
      await service.setWebSettings({ enabled: true });
      await service.syncWeb();
      delete web.notebooks.nb1;
      await service.syncWeb();
      expect(await store.get(idFor(ACCOUNT_A, 'nb1'))).toBeNull();
      expect((await service.state()).web.counts.found).toBe(0);
    });

    it('drops an untouched copy when every quest is removed on the web', async () => {
      const web = fakeWeb(oneNotebook());
      const { service, store } = await setup(new Map([['account-a', web.api]]));
      await service.setWebSettings({ enabled: true });
      await service.syncWeb();
      web.notebooks.nb1 = { ...web.notebooks.nb1, updatedAt: '2026-01-02T00:00:00.000Z', quests: [] };
      await service.syncWeb();
      expect(await store.get(idFor(ACCOUNT_A, 'nb1'))).toBeNull();

      web.notebooks.nb1 = {
        ...web.notebooks.nb1,
        updatedAt: '2026-01-03T00:00:00.000Z',
        quests: [{ id: 'q2', prompt: 'Again?', reply: 'Yes' }],
      };
      await service.syncWeb();
      expect((await store.get(idFor(ACCOUNT_A, 'nb1')))?.messages).toHaveLength(2);
    });

    it('does nothing while signed out', async () => {
      const web = fakeWeb(oneNotebook());
      const { service, store } = await setup(new Map([['account-a', web.api]]), null);
      await service.setWebSettings({ enabled: true });
      await service.syncWeb();
      expect(web.get).not.toHaveBeenCalled();
      expect(await store.list()).toEqual([]);
      expect((await service.state()).signedIn).toBe(false);
    });

    it("keeps each account's web sessions to that account", async () => {
      const webA = fakeWeb(oneNotebook());
      const webB = fakeWeb({
        nbB: { name: 'B only', updatedAt: '2026-01-01T00:00:00.000Z', quests: [{ id: 'qb', prompt: 'b', reply: 'b' }] },
      });
      const { service, store, signIn } = await setup(
        new Map([
          ['account-a', webA.api],
          ['account-b', webB.api],
        ])
      );
      await service.setWebSettings({ enabled: true });
      await service.syncWeb();
      expect((await store.list()).map(session => session.title)).toEqual(['Trip plan']);

      signIn(ACCOUNT_B);
      expect(await store.list()).toEqual([]);
      await service.syncWeb();
      expect((await store.list()).map(session => session.title)).toEqual(['B only']);
      expect(await store.get(idFor(ACCOUNT_B, 'nb1'))).toBeNull();
      expect(webB.get.mock.calls.some(([url]) => url.includes('nb1'))).toBe(false);
    });

    it('removes untouched web sessions, keeps continued ones, and turns sync off', async () => {
      const web = fakeWeb({
        ...oneNotebook(),
        nb2: { name: 'Keep', updatedAt: '2026-01-01T00:00:00.000Z', quests: [{ id: 'q9', prompt: 'x', reply: 'y' }] },
      });
      const { service, store } = await setup(new Map([['account-a', web.api]]));
      await service.setWebSettings({ enabled: true });
      await service.syncWeb();
      await store.appendMessage(idFor(ACCOUNT_A, 'nb2'), { id: 'mine', role: 'user', content: 'mine', createdAt: 'x' });

      expect(await service.removeImported('b4m-web')).toEqual({ removed: 1, keptForked: 1 });
      expect(await store.get(idFor(ACCOUNT_A, 'nb1'))).toBeNull();
      expect(await store.get(idFor(ACCOUNT_A, 'nb2'))).not.toBeNull();
      const state = await service.state();
      expect(state.web.settings.enabled).toBe(false);
      expect(state.web.counts).toEqual({ found: 1, imported: 1, skipped: 0, failed: 0 });
    });

    it('does not bring back a session the user deleted, even after the notebook changes', async () => {
      const web = fakeWeb(oneNotebook());
      const { service, store } = await setup(new Map([['account-a', web.api]]));
      await service.setWebSettings({ enabled: true });
      await service.syncWeb();
      const id = idFor(ACCOUNT_A, 'nb1');
      expect(await store.deleteImported(id, sessionScopeKey(ACCOUNT_A))).toBe('removed');

      web.notebooks.nb1.updatedAt = '2026-01-02T00:00:00.000Z';
      await service.syncWeb();
      expect(await store.get(id)).toBeNull();
      expect((await service.state()).web.counts.found).toBe(0);
    });

    it('reads a notebook again when its chat is longer than the page cap', async () => {
      const get = vi.fn(async () => ({ data: [{ type: 'message', id: 'q', prompt: 'p' }], hasMore: true }));
      const result = await fetchQuests({ get } as unknown as WebApi, 'nb1');
      expect(result.truncated).toBe(true);
      expect(get).toHaveBeenCalledTimes(100);

      const done = vi.fn(async () => ({ data: [], hasMore: false }));
      expect((await fetchQuests({ get: done } as unknown as WebApi, 'nb1')).truncated).toBe(false);
    });

    it('stops importing the remaining notebooks when sync is turned off mid-pass', async () => {
      const notebooks: Record<string, FakeNotebook> = {};
      for (let index = 0; index < 5; index++) {
        notebooks[`nb${index}`] = {
          name: `Notebook ${index}`,
          updatedAt: '2026-01-01T00:00:00.000Z',
          quests: [{ id: `q${index}`, prompt: 'p', reply: 'r' }],
        };
      }
      const web = fakeWeb(notebooks);
      const inner = web.get.getMockImplementation()!;
      let release!: () => void;
      const gate = new Promise<void>(resolve => (release = resolve));
      web.get.mockImplementation(async url => {
        if (url.includes('/chat')) await gate;
        return inner(url);
      });
      const { service, store } = await setup(new Map([['account-a', web.api]]));
      await service.setWebSettings({ enabled: true });
      const run = service.syncWeb();
      await vi.waitFor(() => expect(web.get.mock.calls.filter(([url]) => url.includes('/chat'))).toHaveLength(2));

      await service.setWebSettings({ enabled: false });
      release();
      await run;
      expect(await store.list()).toHaveLength(2);
    });

    describe('on window focus', () => {
      afterEach(() => vi.useRealTimers());
      const listReads = (web: ReturnType<typeof fakeWeb>) =>
        web.get.mock.calls.filter(([url]) => new URL(url, 'https://web.test').pathname === '/api/sessions').length;
      const settle = () => new Promise(resolve => setTimeout(resolve, 25));

      it('syncs at most once a minute', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));
        const web = fakeWeb(oneNotebook());
        const { service } = await setup(new Map([['account-a', web.api]]));
        await service.setWebSettings({ enabled: true });
        await service.syncWeb();
        const base = listReads(web);

        vi.advanceTimersByTime(30_000);
        service.onWindowFocus();
        await settle();
        expect(listReads(web)).toBe(base);

        vi.advanceTimersByTime(31_000);
        service.onWindowFocus();
        await vi.waitFor(() => expect(listReads(web)).toBe(base + 1));
      });

      it('does nothing while a web sync is already running', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));
        const web = fakeWeb(oneNotebook());
        const { service } = await setup(new Map([['account-a', web.api]]));
        await service.setWebSettings({ enabled: true });
        await service.syncWeb();
        const base = listReads(web);

        const inner = web.get.getMockImplementation()!;
        let release!: () => void;
        const gate = new Promise<void>(resolve => (release = resolve));
        web.get.mockImplementation(async url => {
          await gate;
          return inner(url);
        });
        vi.advanceTimersByTime(61_000);
        service.onWindowFocus();
        await vi.waitFor(() => expect(listReads(web)).toBe(base + 1));
        vi.advanceTimersByTime(120_000);
        service.onWindowFocus();
        release();
        await vi.waitFor(() => expect(listReads(web)).toBe(base + 1));
        await settle();
        expect(listReads(web)).toBe(base + 1);
      });
    });
  });
});

describe('ClaudeCodeSync', () => {
  const FIXTURES = join(__dirname, '__fixtures__');
  const SOURCE_ID = '11111111-2222-4333-8444-555555555555';
  const WORKTREE = '/work/example-project/.claude/worktrees/sample';

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'cc-import-'));
    const projects = join(root, 'projects');
    const projectDir = join(projects, '-work-example-project');
    await mkdir(projectDir, { recursive: true });
    const transcriptPath = join(projectDir, `${SOURCE_ID}.jsonl`);
    await copyFile(join(FIXTURES, 'code-session.jsonl'), transcriptPath);
    const store = new SessionStore(join(root, 'sessions'), 'default-model');
    const attachments = new AttachmentStore(join(root, 'attachments'), { debug: () => {}, warn: () => {} });
    const deps = {
      store,
      pickModel: async () => 'picked-model',
      directoryExists: async () => false,
      storeAttachments: async (
        sessionId: string,
        pending: { messageId: string; name: string; mediaType: string; data: Buffer }[]
      ) => {
        const out = new Map();
        for (const item of pending) {
          const result = await attachments.add(sessionId, [
            { source: 'bytes', name: item.name, mediaType: item.mediaType, data: item.data },
          ]);
          out.set(item.messageId, result.attachments);
        }
        return out;
      },
    };
    return { root, projects, projectDir, transcriptPath, store, deps };
  }

  async function indexed(path: string): Promise<IndexedTranscript> {
    const info = await stat(path);
    return {
      path,
      size: info.size,
      mtimeMs: info.mtimeMs,
      sourceId: SOURCE_ID,
      sessionId: codeSessionId(SOURCE_ID),
    };
  }

  async function existingProject(root: string, transcriptPath: string) {
    const repository = join(root, 'repository');
    const worktree = join(repository, '.claude', 'worktrees', 'sample');
    await mkdir(worktree, { recursive: true });
    const transcript = await readFile(transcriptPath, 'utf8');
    await writeFile(transcriptPath, transcript.replaceAll('/work/example-project', repository));
    return { repository, worktree };
  }

  /** The fixture with its torn last line completed, plus the turns that came after. */
  async function completeAndAppend(path: string): Promise<void> {
    const original = await readFile(path, 'utf8');
    const complete = original.slice(0, original.lastIndexOf('\n') + 1);
    await writeFile(path, complete + (await readFile(join(FIXTURES, 'code-session-append.jsonl'), 'utf8')));
  }

  describe('Claude Code import', () => {
    it('maps a transcript: rounds, tool cards, titles, project and the skipped events', async () => {
      const { transcriptPath, store, deps } = await setup();
      const cursor = await importTranscript(await indexed(transcriptPath), undefined, deps);
      expect(cursor.status).toBe('imported');

      const session = (await store.get(codeSessionId(SOURCE_ID)))!;
      expect(session.title).toBe('Sample listing session');
      expect(session.mode).toBe('code');
      expect(session.model).toBe('picked-model');
      // The folder does not exist here, so the session is left unbound rather than pointed at nothing.
      expect(session.project).toBeUndefined();
      expect(session.importOrigin).toMatchObject({
        kind: 'claude-code',
        sourceId: SOURCE_ID,
        cwd: WORKTREE,
        gitBranch: 'feature/sample',
      });
      expect(session.createdAt).toBe('2026-01-02T10:00:00.000Z');

      const users = session.messages.filter(message => message.role === 'user');
      expect(users.map(message => message.content)).toEqual([
        'Please list the files in the sample project.',
        '/review src',
        'What is in this picture?',
      ]);
      // Sidechain turns belong to a subagent, the meta caveat is not the user talking.
      expect(JSON.stringify(session.messages)).not.toContain('Sidechain');
      expect(JSON.stringify(session.messages)).not.toContain('Caveat');

      const reply = session.messages[1];
      expect(reply.role).toBe('assistant');
      expect(reply.content).toBe('Let me look.\n\nThe project has a README and a src folder.');
      expect(reply.thinking).toBeUndefined();
      expect(reply.rounds).toEqual([
        { text: 'Let me look.', toolCallIds: ['toolu_one'], reasoning: 'I should look at the folder first.' },
        { text: '', toolCallIds: ['toolu_two'] },
        { text: 'The project has a README and a src folder.', toolCallIds: [] },
      ]);
      expect(reply.toolCalls).toEqual([
        {
          id: 'toolu_one',
          name: 'bash_execute',
          input: { command: 'ls', description: 'List files' },
          status: 'done',
          preview: 'README.md\nsrc',
        },
        {
          id: 'toolu_two',
          name: 'file_read',
          input: { path: '/work/example-project/missing.md' },
          status: 'error',
          error: 'File does not exist.',
        },
      ]);
      expect(session.messages.every(message => message.id.startsWith('cc-'))).toBe(true);

      const pictured = session.messages.find(message => message.content === 'What is in this picture?')!;
      expect(pictured.attachments).toHaveLength(1);
      expect(pictured.attachments![0]).toMatchObject({ kind: 'image', mediaType: 'image/png' });
      // The torn last line is not consumed, so the reply it held is not here yet.
      expect(session.messages.at(-1)!.role).toBe('user');
      expect(cursor.offset).toBeLessThan((await stat(transcriptPath)).size);
    });

    it('rebuilds a copy an older mapping made, even when the transcript has not changed', async () => {
      const { root, transcriptPath, store, deps } = await setup();
      const { repository, worktree } = await existingProject(root, transcriptPath);
      const exists = { ...deps, directoryExists: async () => true };
      const first = await importTranscript(await indexed(transcriptPath), undefined, exists);
      const old = { ...first, mapVersion: undefined };
      await store.putImported({
        ...(await store.get(codeSessionId(SOURCE_ID)))!,
        project: { ...(await store.get(codeSessionId(SOURCE_ID)))!.project!, directory: worktree, name: 'sample' },
      });

      expect(needsImport(await indexed(transcriptPath), old)).toBe(true);
      const rebuilt = await importTranscript(await indexed(transcriptPath), old, exists);
      expect(rebuilt.mapVersion).toBe(CODE_MAP_VERSION);
      const session = (await store.get(codeSessionId(SOURCE_ID)))!;
      expect(session.project?.directory).toBe(repository);
      const ids = session.messages.map(message => message.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('keeps syncing a session after its worktree is removed', async () => {
      const { root, transcriptPath, store, deps } = await setup();
      const { repository, worktree } = await existingProject(root, transcriptPath);
      const onDisk = {
        ...deps,
        directoryExists: async (path: string) => (await stat(path).catch(() => null))?.isDirectory() ?? false,
      };
      const first = await importTranscript(await indexed(transcriptPath), undefined, onDisk);
      expect((await store.get(codeSessionId(SOURCE_ID)))!.project?.workingDirectory).toBe(worktree);

      await rm(worktree, { recursive: true });
      const old = { ...first, mapVersion: undefined };
      const rebuilt = await importTranscript(await indexed(transcriptPath), old, onDisk);
      expect(rebuilt.status).toBe('imported');
      expect(needsImport(await indexed(transcriptPath), rebuilt)).toBe(false);
      expect((await store.get(codeSessionId(SOURCE_ID)))!.project).toMatchObject({
        directory: repository,
        workspace: false,
        workingDirectory: repository,
      });
    });

    it('appends only what was added since the last read', async () => {
      const { transcriptPath, store, deps } = await setup();
      const first = await importTranscript(await indexed(transcriptPath), undefined, deps);
      const before = (await store.get(codeSessionId(SOURCE_ID)))!.messages.length;

      await completeAndAppend(transcriptPath);
      const transcript = await indexed(transcriptPath);
      expect(needsImport(transcript, first)).toBe(true);
      const second = await importTranscript(transcript, first, deps);
      expect(second.status).toBe('imported');
      expect(second.offset).toBe(transcript.size);

      const session = (await store.get(codeSessionId(SOURCE_ID)))!;
      const added = session.messages.slice(before);
      expect(added.map(message => [message.role, message.content])).toEqual([
        ['assistant', 'It is a single pixel.'],
        ['user', 'Thanks, now check the tests.'],
        ['assistant', ''],
      ]);
      expect(added[2].toolCalls).toEqual([
        {
          id: 'toolu_three',
          name: 'grep_search',
          input: { pattern: 'describe', path: '/work/example-project' },
          status: 'done',
          preview: 'src/a.test.ts',
        },
      ]);
      // Nothing earlier was duplicated by the second read.
      expect(new Set(session.messages.map(message => message.id)).size).toBe(session.messages.length);
      expect(needsImport(transcript, second)).toBe(false);
    });

    it('leaves a torn last line alone until the file changes, and then writes nothing new for it', async () => {
      const { transcriptPath, store, deps } = await setup();
      const first = await importTranscript(await indexed(transcriptPath), undefined, deps);
      expect(needsImport(await indexed(transcriptPath), first)).toBe(false);

      const later = new Date('2026-02-01T00:00:00.000Z');
      await utimes(transcriptPath, later, later);
      const put = vi.spyOn(store, 'putImported');
      const touched = await importTranscript(await indexed(transcriptPath), first, deps);
      expect(put).not.toHaveBeenCalled();
      expect(touched).toMatchObject({ offset: first.offset, mtimeMs: later.getTime(), status: 'imported' });
    });

    it('gives the same rounds whether a sync lands between two lines of one API message or not', async () => {
      const { projectDir, store, deps } = await setup();
      const event = (uuid: string, type: string, message: unknown) =>
        JSON.stringify({ type, uuid, sessionId: SOURCE_ID, timestamp: '2026-01-02T10:00:00.000Z', message }) + '\n';
      const head =
        event('u1', 'user', { role: 'user', content: 'Run it.' }) +
        event('a1', 'assistant', {
          id: 'm1',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
        }) +
        event('u2', 'user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] }) +
        event('a2', 'assistant', {
          id: 'm2',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: '', signature: 's' }],
        });
      const tail = event('a3', 'assistant', {
        id: 'm2',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
      });

      const path = join(projectDir, `${SOURCE_ID}.jsonl`);
      await writeFile(path, head);
      const first = await importTranscript(await indexed(path), undefined, deps);
      await appendFile(path, tail);
      await importTranscript(await indexed(path), first, deps);
      const incremental = (await store.get(codeSessionId(SOURCE_ID)))!.messages.at(-1)!.rounds;

      await store.delete(codeSessionId(SOURCE_ID));
      await importTranscript(await indexed(path), undefined, deps);
      const fresh = (await store.get(codeSessionId(SOURCE_ID)))!.messages.at(-1)!.rounds;
      expect(incremental).toEqual(fresh);
      expect(fresh!.map(round => round.text)).toEqual(['', 'Done.']);
    });

    it('rebuilds rather than resumes a file rewritten under the cursor', async () => {
      const { transcriptPath, store, deps } = await setup();
      const first = await importTranscript(await indexed(transcriptPath), undefined, deps);
      const original = await readFile(transcriptPath, 'utf8');
      // Same bytes shifted by one: the cursor now points mid-line.
      await writeFile(transcriptPath, ' ' + original);
      const second = await importTranscript(await indexed(transcriptPath), first, deps);
      expect(second.status).toBe('imported');
      const ids = (await store.get(codeSessionId(SOURCE_ID)))!.messages.map(message => message.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('stops syncing a session once it is continued here, and never overwrites the desktop turn', async () => {
      const { transcriptPath, store, deps } = await setup();
      const first = await importTranscript(await indexed(transcriptPath), undefined, deps);
      const id = codeSessionId(SOURCE_ID);
      await store.appendMessage(id, {
        id: 'desktop-turn',
        role: 'user',
        content: 'Carry on here',
        createdAt: new Date().toISOString(),
      });
      expect((await store.get(id))!.importOrigin!.forkedAt).toBeTruthy();

      await completeAndAppend(transcriptPath);
      const second = await importTranscript(await indexed(transcriptPath), first, deps);
      expect(second.status).toBe('forked');
      const session = (await store.get(id))!;
      expect(session.messages.at(-1)!.content).toBe('Carry on here');
      expect(JSON.stringify(session.messages)).not.toContain('Thanks, now check the tests.');
      expect(needsImport(await indexed(transcriptPath), second)).toBe(false);
    });

    it('does not bring back a session the user deleted', async () => {
      const { transcriptPath, store, deps } = await setup();
      const first = await importTranscript(await indexed(transcriptPath), undefined, deps);
      await store.delete(codeSessionId(SOURCE_ID));
      await completeAndAppend(transcriptPath);
      const second = await importTranscript(await indexed(transcriptPath), first, deps);
      expect(second.status).toBe('removed');
      expect(await store.get(codeSessionId(SOURCE_ID))).toBeNull();
    });

    it('files the session under its repository, running in its own worktree while that is still there', async () => {
      const { root, transcriptPath, store, deps } = await setup();
      const { repository, worktree } = await existingProject(root, transcriptPath);
      await importTranscript(await indexed(transcriptPath), undefined, { ...deps, directoryExists: async () => true });
      expect((await store.get(codeSessionId(SOURCE_ID)))!.project).toEqual({
        directory: repository,
        name: 'repository',
        branch: 'feature/sample',
        workspace: true,
        workspaceBranch: 'feature/sample',
        workingDirectory: worktree,
        contextDirectories: [],
      });

      const repositoryOnly = async (path: string) => path === repository;
      expect(await projectFor(worktree, 'feature/sample', repositoryOnly)).toMatchObject({
        directory: repository,
        workspace: false,
        workingDirectory: repository,
      });
    });

    it('syncs only sessions that ran in a .claude/worktrees worktree', () => {
      const all = { enabled: true, sourceFolder: null, projects: 'all' as const, includeSubagents: false };
      expect(claudeWorktreeOf('/r/.claude/worktrees/a/apps/web')).toEqual({
        repository: '/r',
        worktree: '/r/.claude/worktrees/a',
      });
      expect(matchesFilter('/r/.claude/worktrees/a', all)).toBe(true);
      expect(matchesFilter('/r/.manifold/worktrees/a', all)).toBe(false);
      expect(matchesFilter('/r', all)).toBe(false);
      expect(matchesFilter(undefined, all)).toBe(false);
      expect(matchesFilter('/r/.claude/worktrees/a', { ...all, projects: ['/r'] })).toBe(true);
      expect(matchesFilter('/s/.claude/worktrees/a', { ...all, projects: ['/r'] })).toBe(false);
    });

    it('indexes by stat and a head read, including subagent files only when asked', async () => {
      const { projects, projectDir, transcriptPath } = await setup();
      const subagents = join(projectDir, SOURCE_ID, 'subagents');
      await mkdir(subagents, { recursive: true });
      await writeFile(join(subagents, 'agent-abc123.jsonl'), '');
      await writeFile(join(projectDir, 'notes.txt'), 'ignored');

      expect((await listTranscripts(projects, false)).map(entry => entry.sessionId)).toEqual([`cc-${SOURCE_ID}`]);
      const withAgents = await listTranscripts(projects, true);
      const agentId = `cca-${SOURCE_ID}-abc123`;
      expect(withAgents.map(entry => entry.sessionId).sort()).toEqual([`cc-${SOURCE_ID}`, agentId]);
      expect(withAgents.find(entry => entry.sessionId === agentId)!.parentSourceId).toBe(SOURCE_ID);
      expect(codeSessionId('a'.repeat(40), SOURCE_ID)).toMatch(/^cca-[0-9a-f]{40}$/);

      // A resumed session carries a copy of its parent's subagent files under its own id.
      const resumed = '99999999-2222-4333-8444-555555555555';
      await mkdir(join(projectDir, resumed, 'subagents'), { recursive: true });
      await writeFile(join(projectDir, resumed, 'subagents', 'agent-abc123.jsonl'), '');
      expect((await listTranscripts(projects, true)).map(entry => entry.sessionId).sort()).toEqual([
        `cc-${SOURCE_ID}`,
        agentId,
        `cca-${resumed}-abc123`,
      ]);

      const peeked = await peekTranscript(await indexed(transcriptPath));
      expect(peeked.cwd).toBe(WORKTREE);
    });

    it('counts by status within the project filter', () => {
      const transcripts = ['a', 'b', 'c', 'd', 'e'].map(name => ({
        path: name,
        size: 1,
        mtimeMs: 1,
        sourceId: name,
        sessionId: name,
      }));
      const cursor = (status: FileCursor['status'], cwd: string): FileCursor => ({
        sessionId: 'x',
        size: 1,
        mtimeMs: 1,
        offset: 1,
        status,
        cwd,
      });
      const files = {
        a: cursor('imported', '/p/.claude/worktrees/one'),
        b: cursor('forked', '/p/.claude/worktrees/two'),
        c: cursor('failed', '/p/.claude/worktrees/one'),
        d: cursor('imported', '/q/.claude/worktrees/one'),
        e: cursor('imported', '/p/.manifold/worktrees/one'),
      };
      expect(
        countsFor(files, transcripts, { enabled: true, sourceFolder: null, projects: ['/p'], includeSubagents: false })
      ).toEqual({
        found: 3,
        imported: 2,
        skipped: 0,
        failed: 1,
        forked: 1,
      });
    });

    it('renames Claude Code tools onto the desktop cards and keeps unknown ones as they are', () => {
      expect(mapToolCall('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' })).toEqual({
        name: 'file_edit',
        input: { path: '/a', oldText: 'x', newText: 'y' },
      });
      expect(mapToolCall('mcp__server__tool', { q: 1 })).toEqual({ name: 'mcp__server__tool', input: { q: 1 } });
      expect(mapToolCall('Agent', 'not an object')).toEqual({ name: 'Agent', input: {} });
    });
    it('keeps a tool or argument named after an Object member as it is', () => {
      expect(mapToolCall('constructor', { toString: 'a' })).toEqual({ name: 'constructor', input: { toString: 'a' } });
      expect(mapToolCall('Edit', { constructor: 'x' })).toEqual({ name: 'file_edit', input: { constructor: 'x' } });
    });
    it('keeps a deletion made while an import is waiting on project resolution', async () => {
      const { transcriptPath, store, deps } = await setup();
      const first = await importTranscript(await indexed(transcriptPath), undefined, deps);
      await completeAndAppend(transcriptPath);
      const id = codeSessionId(SOURCE_ID);
      let resolveReached!: () => void;
      const reached = new Promise<void>(resolve => {
        resolveReached = resolve;
      });
      let releaseProject!: () => void;
      const projectReady = new Promise<void>(resolve => {
        releaseProject = resolve;
      });
      const running = importTranscript(await indexed(transcriptPath), first, {
        ...deps,
        directoryExists: async () => {
          resolveReached();
          await projectReady;
          return false;
        },
      });
      await reached;
      await store.delete(id);
      releaseProject();
      expect((await running).status).toBe('removed');
      expect(await store.get(id)).toBeNull();
    });

    it('retries an unchanged transcript after a failed import', async () => {
      const { transcriptPath } = await setup();
      const transcript = await indexed(transcriptPath);
      const failed: FileCursor = {
        sessionId: transcript.sessionId,
        size: transcript.size,
        mtimeMs: transcript.mtimeMs,
        offset: 0,
        status: 'failed',
        error: 'Temporary I/O error',
      };
      expect(needsImport(transcript, failed)).toBe(true);
    });
  });
});

describe('claudeCodeMapper', () => {
  let seq = 0;
  const base = () => ({
    uuid: `e-${++seq}`,
    sessionId: 's',
    timestamp: '2026-01-02T10:00:00.000Z',
    isSidechain: false,
  });
  const user = (text: string) => ({ ...base(), type: 'user', message: { role: 'user', content: text } });
  const assistant = (messageId: string, block: Record<string, unknown>) => ({
    ...base(),
    type: 'assistant',
    message: { id: messageId, role: 'assistant', content: [block], stop_reason: 'tool_use' },
  });
  const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
  const result = (id: string, text: string) => ({
    ...base(),
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  });

  function importEvents(events: unknown[]): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const state: CodeMapState = {};
    for (const event of events) applyCodeEvent(event, messages, state, []);
    return tidyMessages(messages);
  }

  describe('an imported Claude Code transcript that plans with TaskCreate / TaskUpdate', () => {
    const events = [
      user('Fix the build'),
      assistant('m1', use('t1', 'TaskCreate', { subject: 'Read the logs', activeForm: 'Reading the logs' })),
      result('t1', 'Task #1 created successfully: Read the logs'),
      assistant('m2', use('t2', 'TaskCreate', { subject: 'Patch the config', activeForm: 'Patching the config' })),
      result('t2', 'Task #7 created successfully: Patch the config'),
      assistant('m3', use('t3', 'TaskCreate', { subject: 'Try a rewrite' })),
      result('t3', 'Task #3 created successfully: Try a rewrite'),
      assistant('m4', { type: 'text', text: 'Plan is set.' }),
      user('go ahead'),
      assistant('m5', use('t4', 'TaskUpdate', { taskId: '1', status: 'completed' })),
      result('t4', 'Updated task #1 status'),
      assistant('m6', use('t5', 'TaskUpdate', { taskId: '7', status: 'in_progress' })),
      result('t5', 'Updated task #2 status'),
      assistant('m7', use('t6', 'TaskUpdate', { taskId: '3', status: 'cancelled' })),
      result('t6', 'Updated task #3 status'),
    ];

    it('yields the folded plan for the panel', () => {
      expect(activeTodos(importEvents(events), false)).toEqual([
        { id: '1', content: 'Read the logs', activeForm: 'Reading the logs', status: 'completed' },
        { id: '7', content: 'Patch the config', activeForm: 'Patching the config', status: 'in_progress' },
        { id: '3', content: 'Try a rewrite', status: 'cancelled' },
      ]);
    });

    it('shows no plan once a later reply no longer touches it', () => {
      const later = [...events, user('thanks'), assistant('m8', { type: 'text', text: 'You are welcome.' })];
      expect(activeTodos(importEvents(later), false)).toBeNull();
    });
  });
});

describe('ClaudeChatImport', () => {
  const FIXTURES = join(__dirname, '__fixtures__');
  const GARDEN = 'aaaaaaaa-0000-4000-8000-000000000001';
  const UNTITLED = 'bbbbbbbb-0000-4000-8000-000000000002';

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'chat-import-'));
    const store = new SessionStore(join(root, 'sessions'), 'default-model');
    const seen: Record<string, string> = {};
    const stored: { sessionId: string; names: string[] }[] = [];
    const deps = {
      store,
      seen,
      pickModel: async () => 'picked-model',
      storeAttachments: async (sessionId: string, pending: { messageId: string; name: string }[]) => {
        stored.push({ sessionId, names: pending.map(item => item.name) });
        return new Map(
          pending.map(item => [
            item.messageId,
            [
              {
                id: 'att1',
                kind: 'text' as const,
                name: item.name,
                mediaType: 'text/plain',
                byteSize: 1,
                sourceBytes: 1,
              },
            ],
          ])
        );
      },
    };
    return { root, store, seen, stored, deps };
  }

  async function exportZip(
    root: string,
    conversations: Buffer,
    extra: { name: string; data: Buffer }[] = []
  ): Promise<string> {
    const path = join(root, 'data-export.zip');
    await writeFile(
      path,
      buildZip([
        { name: 'users.json', data: Buffer.from('[]') },
        { name: 'conversations.json', data: conversations },
        ...extra,
      ])
    );
    return path;
  }

  describe('Claude chat export import', () => {
    it('imports conversations from an export zip and maps their messages', async () => {
      const { root, store, deps, stored } = await setup();
      const path = await exportZip(root, await readFile(join(FIXTURES, 'conversations.json')));
      expect(await looksLikeClaudeExport(path)).toBe(true);

      const summary = await importChatExport(path, deps);
      expect(summary.error).toBeUndefined();
      expect(summary.counts).toEqual({ found: 4, imported: 2, updated: 0, unchanged: 0, skipped: 1, failed: 1 });

      const garden = (await store.get(chatSessionId(GARDEN)))!;
      expect(garden.title).toBe('Planning a garden');
      expect(garden.mode).toBe('chat');
      expect(garden.importOrigin).toMatchObject({
        kind: 'claude-chat',
        sourceId: GARDEN,
        sourceUpdatedAt: '2025-12-01T09:05:00.000Z',
      });
      const [prompt, reply] = garden.messages;
      expect(prompt.content).toBe(
        'Which vegetables grow well in shade? \u00e9\u00e8 \u{1F955}\n\n[Files not included in the export: photo.jpg]'
      );
      expect(prompt.attachments?.map(attachment => attachment.name)).toEqual(['notes.txt']);
      expect(stored).toEqual([{ sessionId: chatSessionId(GARDEN), names: ['notes.txt'] }]);
      expect(reply.content).toBe('Leafy greens such as lettuce [and] spinach {do} well.\n\nSources agree.');
      expect(reply.rounds).toEqual([
        {
          text: 'Leafy greens such as lettuce [and] spinach {do} well.',
          toolCallIds: [`${reply.id}-t2`],
          reasoning: 'Leafy greens tolerate shade.',
        },
        { text: 'Sources agree.', toolCallIds: [] },
      ]);
      expect(reply.toolCalls).toEqual([
        {
          id: `${reply.id}-t2`,
          name: 'web_search',
          input: { query: 'shade vegetables' },
          status: 'done',
          preview: 'result one',
        },
      ]);

      // No name: titled from the first prompt.
      expect((await store.get(chatSessionId(UNTITLED)))!.title).toBe(
        'Untitled question about "quotes" and \\ backslashes'
      );
    });

    it('dedupes a re-import by uuid and updates only conversations that changed', async () => {
      const { root, store, deps } = await setup();
      const fixture = JSON.parse(await readFile(join(FIXTURES, 'conversations.json'), 'utf8'));
      const path = join(root, 'conversations.json');
      await writeFile(path, JSON.stringify(fixture));
      await importChatExport(path, deps);

      fixture[0].updated_at = '2025-12-05T10:00:00.000000Z';
      fixture[0].chat_messages.push({
        uuid: 'dddddddd-0000-4000-8000-000000000003',
        text: 'And in full sun?',
        content: [{ type: 'text', text: 'And in full sun?' }],
        sender: 'human',
        created_at: '2025-12-05T10:00:00.000000Z',
        attachments: [],
        files: [],
      });
      await writeFile(path, JSON.stringify(fixture));
      const second = await importChatExport(path, deps);
      expect(second.counts).toMatchObject({ found: 4, imported: 0, updated: 1, unchanged: 1 });
      const garden = (await store.get(chatSessionId(GARDEN)))!;
      expect(garden.messages.at(-1)!.content).toBe('And in full sun?');
      expect(garden.messages).toHaveLength(3);
      expect((await store.list()).filter(session => session.importOrigin?.kind === 'claude-chat')).toHaveLength(2);
    });

    it('leaves a conversation the user continued here alone on re-import', async () => {
      const { root, store, deps } = await setup();
      const fixture = JSON.parse(await readFile(join(FIXTURES, 'conversations.json'), 'utf8'));
      const path = join(root, 'conversations.json');
      await writeFile(path, JSON.stringify(fixture));
      await importChatExport(path, deps);
      await store.appendMessage(chatSessionId(GARDEN), {
        id: 'mine',
        role: 'user',
        content: 'My own follow-up',
        createdAt: new Date().toISOString(),
      });

      fixture[0].updated_at = '2025-12-09T10:00:00.000000Z';
      fixture[0].name = 'Renamed upstream';
      await writeFile(path, JSON.stringify(fixture));
      const second = await importChatExport(path, deps);
      expect(second.counts.skipped).toBe(2);
      const garden = (await store.get(chatSessionId(GARDEN)))!;
      expect(garden.title).toBe('Planning a garden');
      expect(garden.messages.at(-1)!.content).toBe('My own follow-up');
    });

    it('does not bring back a conversation deleted here, and does not re-store kept attachments', async () => {
      const { root, store, deps, stored } = await setup();
      const fixture = JSON.parse(await readFile(join(FIXTURES, 'conversations.json'), 'utf8'));
      const path = join(root, 'conversations.json');
      await writeFile(path, JSON.stringify(fixture));
      await importChatExport(path, deps);
      await store.delete(chatSessionId(UNTITLED));

      fixture[0].updated_at = '2025-12-05T10:00:00.000000Z';
      fixture[0].name = 'Planning a bigger garden';
      await writeFile(path, JSON.stringify(fixture));
      const second = await importChatExport(path, deps);
      expect(second.counts).toMatchObject({ updated: 1, skipped: 2 });
      expect(await store.get(chatSessionId(UNTITLED))).toBeNull();
      expect(stored).toHaveLength(1);
      const garden = (await store.get(chatSessionId(GARDEN)))!;
      expect(garden.messages[0].attachments?.map(attachment => attachment.name)).toEqual(['notes.txt']);
    });

    it('does not recreate a conversation deleted after its update was read', async () => {
      const { root, store, deps } = await setup();
      const fixture = JSON.parse(await readFile(join(FIXTURES, 'conversations.json'), 'utf8'));
      const path = join(root, 'conversations.json');
      await writeFile(path, JSON.stringify([fixture[0]]));
      await importChatExport(path, deps);
      fixture[0].updated_at = '2025-12-09T10:00:00Z';
      await writeFile(path, JSON.stringify([fixture[0]]));
      const original = store.putImported.bind(store);
      vi.spyOn(store, 'putImported').mockImplementationOnce(async (session, scopeKey, options) => {
        await store.delete(session.id);
        return original(session, scopeKey, options);
      });
      expect((await importChatExport(path, deps)).counts.skipped).toBe(1);
      expect(await store.get(chatSessionId(GARDEN))).toBeNull();
      expect((await importChatExport(path, deps)).counts.skipped).toBe(1);
      expect(await store.get(chatSessionId(GARDEN))).toBeNull();
    });

    it('refuses archives with traversal names, with no conversations.json, or past the size limit', async () => {
      const { root, deps } = await setup();
      const traversal = join(root, 'traversal.zip');
      await writeFile(
        traversal,
        buildZip([
          { name: 'conversations.json', data: Buffer.from('[]') },
          { name: '../../outside.json', data: Buffer.from('{}') },
        ])
      );
      expect((await importChatExport(traversal, deps)).error).toMatch(/unsafe file name/);

      const other = join(root, 'other.zip');
      await writeFile(other, buildZip([{ name: 'photos/a.json', data: Buffer.from('[]') }]));
      expect(await looksLikeClaudeExport(other)).toBe(false);
      expect((await importChatExport(other, deps)).error).toMatch(/no conversations.json/);

      const bomb = join(root, 'bomb.zip');
      await writeFile(
        bomb,
        buildZip([{ name: 'conversations.json', data: Buffer.from('[]'), claimedSize: 0xfffffff0 }])
      );
      expect((await importChatExport(bomb, deps)).error).toMatch(/limit|zip64/);
    });

    it('reads conversations.json from one folder down, never anything deeper', async () => {
      const { root, deps } = await setup();
      const nested = join(root, 'nested.zip');
      const conversations = await readFile(join(FIXTURES, 'conversations.json'));
      await writeFile(nested, buildZip([{ name: 'export/conversations.json', data: conversations }]));
      expect((await importChatExport(nested, deps)).counts.imported).toBe(2);

      const deep = join(root, 'deep.zip');
      await writeFile(deep, buildZip([{ name: 'a/b/conversations.json', data: conversations }]));
      expect((await importChatExport(deep, deps)).error).toMatch(/no conversations.json/);
    });
  });
});

describe('continuation', () => {
  const at = '2026-01-01T00:00:00.000Z';

  function session(messages: ChatMessage[], imported = true): ChatSession {
    return {
      id: 'cc-s',
      title: 't',
      model: 'm',
      createdAt: at,
      updatedAt: at,
      mode: 'chat',
      approvalMode: 'ask',
      reasoningEffort: 'default',
      ...(imported
        ? { importOrigin: { kind: 'claude-code' as const, sourceId: 's', importedAt: at, sourceUpdatedAt: at } }
        : {}),
      messages,
    };
  }

  describe('continuing an imported session', () => {
    it('flattens an imported tool turn into prose with capped results', () => {
      const message: ChatMessage = {
        id: 'cc-1',
        role: 'assistant',
        content: 'Checked.',
        createdAt: at,
        toolCalls: [
          { id: 't1', name: 'bash_execute', input: { command: 'ls' }, status: 'done', preview: 'x'.repeat(5000) },
          { id: 't2', name: 'Agent', input: {}, status: 'error', error: 'boom' },
        ],
      };
      expect(isImportedToolTurn(message)).toBe(true);
      expect(isImportedToolTurn({ ...message, id: 'own' })).toBe(false);
      const text = importedTurnAsText(message, message.content);
      expect(text.startsWith('Checked.\n\n[Earlier tool call: bash_execute ls]\n\n[Result]\n')).toBe(true);
      expect(text).toContain('[... truncated ...]');
      expect(text.endsWith('[Earlier tool call: Agent]\n\n[Error]\nboom')).toBe(true);
      expect(text.length).toBeLessThan(2000);
    });

    it('compacts first only when the imported history since the last boundary is large', () => {
      const big = (id: string): ChatMessage => ({
        id,
        role: 'user',
        content: 'y'.repeat(IMPORTED_COMPACT_CHARS / 2 + 1),
        createdAt: at,
      });
      expect(importedHistoryNeedsCompaction(session([big('cc-1')]))).toBe(false);
      expect(importedHistoryNeedsCompaction(session([big('cc-1'), big('cc-2')]))).toBe(true);
      // Not an import, or already compacted past the imported part: nothing to do.
      expect(importedHistoryNeedsCompaction(session([big('cc-1'), big('cc-2')], false))).toBe(false);
      const boundary: ChatMessage = {
        id: 'own',
        role: 'user',
        content: 'summary',
        createdAt: at,
        system: true,
        boundary: { kind: 'compact' },
      };
      expect(importedHistoryNeedsCompaction(session([big('cc-1'), big('cc-2'), boundary]))).toBe(false);
    });
  });
});

describe('webSessionMapper', () => {
  const AT = '2026-01-01T00:00:00.000Z';

  describe('readNotebook', () => {
    it('reads id, name and timestamps, and versions on both update stamps', () => {
      const notebook = readNotebook({
        id: '65a1b2c3d4e5f60718293a4b',
        name: ' Trip plan ',
        firstCreated: '2026-01-01T00:00:00Z',
        lastUpdated: '2026-01-02T00:00:00Z',
        updatedAt: '2026-01-03T00:00:00Z',
      });
      expect(notebook).toEqual({
        id: '65a1b2c3d4e5f60718293a4b',
        name: 'Trip plan',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
        version: '2026-01-03T00:00:00.000Z|2026-01-02T00:00:00.000Z',
      });
    });

    it('rejects rows without a safe id', () => {
      expect(readNotebook({ id: '../etc', name: 'x' })).toBeNull();
      expect(readNotebook({ name: 'x' })).toBeNull();
      expect(readNotebook(null)).toBeNull();
    });
  });

  describe('mapQuests', () => {
    it('maps each quest to its prompt and reply with stable imported ids', () => {
      const { messages, settled } = mapQuests(
        [
          {
            id: 'q1',
            type: 'message',
            prompt: 'Hi',
            reply: 'Hello',
            timestamp: '2026-01-01T00:00:01Z',
            status: 'done',
          },
          { id: 'q2', type: 'message', prompt: 'More', replies: ['', 'Sure'], timestamp: '2026-01-01T00:00:02Z' },
          { id: 'q3', type: 'system', prompt: 'internal', reply: 'x' },
          { id: 'q1', type: 'message', prompt: 'dup', reply: 'dup' },
        ],
        AT
      );
      expect(settled).toBe(true);
      expect(messages.map(message => [message.id, message.role, message.content])).toEqual([
        ['bw-q1-p', 'user', 'Hi'],
        ['bw-q1-r', 'assistant', 'Hello'],
        ['bw-q2-p', 'user', 'More'],
        ['bw-q2-r', 'assistant', 'Sure'],
      ]);
      expect(messages[1].rounds).toEqual([{ text: 'Hello', toolCallIds: [] }]);
      expect(messages.every(message => isImportedMessageId(message.id))).toBe(true);
    });

    it('reports a running reply as unsettled and keeps its prompt', () => {
      const { messages, settled } = mapQuests([{ id: 'q1', prompt: 'Wait', status: 'running' }], AT);
      expect(settled).toBe(false);
      expect(messages).toHaveLength(1);
      expect(messages[0].createdAt).toBe(AT);
    });
  });

  describe('b4m-web import origin', () => {
    it('is a recognised import kind', () => {
      expect(normalizeImportOrigin({ kind: 'b4m-web', sourceId: 'abc' })).toMatchObject({ kind: 'b4m-web' });
    });
  });
});

describe('ImportStateStore', () => {
  describe('ImportStateStore settings', () => {
    it('keeps a write that lands while the file is still being read', async () => {
      const root = await mkdtemp(join(tmpdir(), 'import-state-'));
      const settingsPath = join(root, 'claude-import.json');
      await writeFile(settingsPath, JSON.stringify(DEFAULT_SETTINGS), 'utf8');
      const store = new ImportStateStore(settingsPath, join(root, 'state'));

      let release!: () => void;
      slowRead.gate = new Promise<void>(resolve => (release = resolve));
      const reading = store.readSettings();
      slowRead.gate = null;
      await store.writeSettings({ ...DEFAULT_SETTINGS, web: { enabled: true } });
      release();

      expect((await reading).web.enabled).toBe(true);
      expect((await store.readSettings()).web.enabled).toBe(true);
    });
  });

  describe('ImportStateStore hint dismissals', () => {
    it('keeps them per account across a restart', async () => {
      const root = await mkdtemp(join(tmpdir(), 'import-hints-'));
      const settingsPath = join(root, 'claude-import.json');
      const stateDirectory = join(root, 'state');
      const store = new ImportStateStore(settingsPath, stateDirectory);
      await store.dismissHint('account-a', 'claude-code');
      await store.dismissHint('account-a', 'claude-code');
      await store.dismissHint('account-a', 'web');

      const restarted = new ImportStateStore(settingsPath, stateDirectory);
      expect((await restarted.scope('account-a')).dismissedHints).toEqual(['claude-code', 'web']);
      expect((await restarted.scope('account-b')).dismissedHints).toEqual([]);
    });

    it('reads a state file from before dismissals, and drops unknown ids', async () => {
      const root = await mkdtemp(join(tmpdir(), 'import-hints-'));
      const stateDirectory = join(root, 'state');
      await mkdir(stateDirectory, { recursive: true });
      await writeFile(join(stateDirectory, 'old.json'), JSON.stringify({ version: 1, files: {} }), 'utf8');
      await writeFile(
        join(stateDirectory, 'odd.json'),
        JSON.stringify({ version: 1, dismissedHints: ['web', 'tour', 7] }),
        'utf8'
      );
      const store = new ImportStateStore(join(root, 'claude-import.json'), stateDirectory);
      expect((await store.scope('old')).dismissedHints).toEqual([]);
      expect((await store.scope('odd')).dismissedHints).toEqual(['web']);
    });
  });
});

describe('json streams and zip reading', () => {
  async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of source) out.push(item);
    return out;
  }

  async function* chunked(text: string, size: number): AsyncGenerator<Buffer> {
    const bytes = Buffer.from(text, 'utf8');
    for (let index = 0; index < bytes.length; index += size) yield bytes.subarray(index, index + size);
  }

  describe('readJsonlLines', () => {
    it('yields complete lines, leaves an unterminated last line, and resumes from an offset', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'jsonl-'));
      const path = join(dir, 'a.jsonl');
      await writeFile(path, '{"a":1}\n{"b":"\u00e9"}\n{"partial":');
      const lines = await collect(readJsonlLines(path, 0, 1024));
      expect(lines.map(line => line.text)).toEqual(['{"a":1}', '{"b":"\u00e9"}']);
      const resumeAt = lines[1].end;
      await writeFile(path, '{"a":1}\n{"b":"\u00e9"}\n{"partial":true}\n');
      const more = await collect(readJsonlLines(path, resumeAt, 1024));
      expect(more.map(line => line.text)).toEqual(['{"partial":true}']);
    });

    it('skips an oversize line without reading it, and keeps going', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'jsonl-'));
      const path = join(dir, 'big.jsonl');
      await writeFile(path, `${'x'.repeat(600 * 1024)}\n{"after":1}\n`);
      const lines = await collect(readJsonlLines(path, 0, 1024));
      expect(lines.map(line => line.text)).toEqual([null, '{"after":1}']);
    });

    it.each([
      { cap: 10, length: 10, skipped: false },
      { cap: 10, length: 11, skipped: true },
      { cap: 10, length: 100, skipped: true },
      { cap: 256 * 1024, length: 256 * 1024, skipped: false },
      { cap: 256 * 1024, length: 256 * 1024 + 1, skipped: true },
    ])('checks the final piece before a newline: $cap bytes, $length characters', async ({ cap, length, skipped }) => {
      const directory = await mkdtemp(join(tmpdir(), 'jsonl-cap-'));
      const path = join(directory, 'line.jsonl');
      await writeFile(path, `${'x'.repeat(length)}\n{}\n`);
      const lines = await collect(readJsonlLines(path, 0, cap));
      expect(lines[0].text).toBe(skipped ? null : 'x'.repeat(length));
      expect(lines[1].text).toBe('{}');
      expect(lines[0].end).toBe(length + 1);
    });

    it('reads only the head and tail for indexing', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'jsonl-'));
      const path = join(dir, 'long.jsonl');
      const body = Array.from({ length: 2000 }, (_, index) => JSON.stringify({ index })).join('\n') + '\n';
      await writeFile(path, body);
      const { head, tail } = await readHeadAndTail(path, Buffer.byteLength(body), 256);
      expect(JSON.parse(head[0])).toEqual({ index: 0 });
      expect(JSON.parse(tail.at(-1)!)).toEqual({ index: 1999 });
      expect(head.length + tail.length).toBeLessThan(100);
    });
  });

  describe('streamJsonArray', () => {
    it('splits elements across chunk boundaries, through strings, escapes and multi-byte text', async () => {
      const value = [{ a: '[not] {a} "quoted" \\ end', b: '\u00e9\u{1F955}' }, { c: [1, [2]] }, 7, { d: {} }];
      for (const size of [1, 3, 7, 64]) {
        const out = await collect(streamJsonArray(chunked(JSON.stringify(value), size), 1024));
        expect(out).toEqual([value[0], value[1], value[3]]);
      }
    });

    it('reports an oversize element as null and carries on', async () => {
      const value = [{ big: 'y'.repeat(500) }, { small: 1 }];
      const out = await collect(streamJsonArray(chunked(JSON.stringify(value), 16), 100));
      expect(out).toEqual([null, { small: 1 }]);
    });

    it('rejects something that is not an array, and a truncated one', async () => {
      await expect(collect(streamJsonArray(chunked('{"a":1}', 4), 100))).rejects.toThrow(/JSON array/);
      await expect(collect(streamJsonArray(chunked('[{"a":1},{"b"', 4), 100))).rejects.toThrow(/part-way/);
    });
  });

  describe('zip reader', () => {
    it('lists members and inflates one', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'zip-'));
      const path = join(dir, 'export.zip');
      await writeFile(
        path,
        buildZip([
          { name: 'users.json', data: Buffer.from('[]') },
          { name: 'conversations.json', data: Buffer.from('[{"a":1}]') },
          { name: 'stored.txt', data: Buffer.from('plain'), stored: true },
        ])
      );
      const members = await listZipMembers(path);
      expect(members.map(member => member.name)).toEqual(['users.json', 'conversations.json', 'stored.txt']);
      const text = Buffer.concat(await collect(readZipMember(path, members[1], 1024))).toString();
      expect(text).toBe('[{"a":1}]');
      expect(Buffer.concat(await collect(readZipMember(path, members[2], 1024))).toString()).toBe('plain');
    });

    it('stops a member that inflates past the limit even when its header lies', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'zip-'));
      const path = join(dir, 'bomb.zip');
      await writeFile(
        path,
        buildZip([{ name: 'conversations.json', data: Buffer.alloc(200_000, 0x20), claimedSize: 10 }])
      );
      const [member] = await listZipMembers(path);
      await expect(collect(readZipMember(path, member, 50_000))).rejects.toThrow(ZipError);
    });

    it('refuses encrypted members and a member the header says is too big', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'zip-'));
      const path = join(dir, 'x.zip');
      await writeFile(
        path,
        buildZip([
          { name: 'a.json', data: Buffer.from('[]'), encrypted: true },
          { name: 'b.json', data: Buffer.alloc(5000) },
        ])
      );
      const [encrypted, big] = await listZipMembers(path);
      await expect(collect(readZipMember(path, encrypted, 1024))).rejects.toThrow(/encrypted/);
      await expect(collect(readZipMember(path, big, 1024))).rejects.toThrow(/limit/);
    });

    it('fails the read, rather than hanging, when the disk errors under an inflating member', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'zip-'));
      const path = join(dir, 'export.zip');
      await writeFile(path, buildZip([{ name: 'conversations.json', data: Buffer.from('[{"a":1}]') }]));
      const [member] = await listZipMembers(path);
      readFailure.next = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      await expect(collect(readZipMember(path, member, 1024))).rejects.toThrow(/EIO/);
    });

    it('rejects a file that is not a zip', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'zip-'));
      const path = join(dir, 'fake.zip');
      await writeFile(path, 'not a zip at all, just text that is long enough');
      await expect(listZipMembers(path)).rejects.toThrow(ZipError);
    });

    it('rejects an oversized central directory before allocating it', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'zip-'));
      const path = join(dir, 'large-directory.zip');
      const size = 20 * 1024 * 1024;
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt32LE(size, 12);
      const file = await open(path, 'w');
      try {
        await file.write(end, 0, end.length, size);
      } finally {
        await file.close();
      }
      await expect(listZipMembers(path)).rejects.toThrow(/central directory is larger/);
    });

    it('flags member names that would escape an extraction folder', () => {
      for (const name of ['../evil.json', 'a/../../b', '/abs.json', 'C:/x.json', 'a\\b.json', '']) {
        expect(isUnsafeMemberName(name)).toBe(true);
      }
      for (const name of ['conversations.json', 'export/conversations.json', 'a..b.json']) {
        expect(isUnsafeMemberName(name)).toBe(false);
      }
    });
  });
});

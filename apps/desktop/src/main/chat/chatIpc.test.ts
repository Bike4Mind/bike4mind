// The chat IPC registrations, one describe per module, kept in one file because every test file pays its own import and setup.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { ComposerDraftStore } from './ComposerDraftStore';
import { registerComposerDraftsIpc, SESSION_ID_MAX_LENGTH } from './composerDraftsIpc';
import { registerGenerationIpc } from './generationIpc';
import { SessionStore } from './SessionStore';
import { registerHistoryIpc } from './historyIpc';
import { LocalContextPreference } from './LocalContextPreference';
import { registerLocalContextIpc } from './localContextIpc';
import { inheritancePolicy } from '@shared/orchestration';
import { registerOrchestrationIpc } from './orchestrationIpc';
import type { ChatSession, ChatSessionExportResult, ChatSessionSummary } from '@shared/chat';
import { registerSessionCreateIpc, type SessionCreation } from './sessionCreateIpc';
import { registerSessionExportIpc } from './sessionExportIpc';
import { registerSessionOrchestrateIpc } from './sessionOrchestrateIpc';
import { SIDEBAR_SESSION_ID_MAX_LENGTH } from '@shared/sidebarSections';
import { placeNewSession, registerSidebarIpc } from './sidebarIpc';
import type { SidebarSectionStore } from './SidebarSectionStore';
import { SpawnLocationPreference } from './SpawnLocationPreference';
import { registerSpawnLocationIpc } from './spawnLocationIpc';

describe('composerDraftsIpc', () => {
  type Handler = Parameters<IpcMain['handle']>[1];

  async function setup(
    known: string[] = ['s1'],
    isKnownSession = async (sessionId: string) => known.includes(sessionId)
  ) {
    const handlers = new Map<string, Handler>();
    const store = new ComposerDraftStore(join(await mkdtemp(join(tmpdir(), 'composer-drafts-ipc-')), 'drafts.json'));
    registerComposerDraftsIpc(
      { handle: (channel: string, handler: Handler) => void handlers.set(channel, handler) },
      store,
      store.load(),
      isKnownSession
    );
    const call = (channel: string, ...args: unknown[]) =>
      handlers.get(channel)?.({} as Parameters<Handler>[0], ...args);
    return { store, call };
  }

  describe('registerComposerDraftsIpc', () => {
    it('saves, lists and clears a known conversation draft', async () => {
      const { call } = await setup();
      await call(IPC_CHANNELS.composerDraftsSave, 's1', 'hello');
      expect(await call(IPC_CHANNELS.composerDraftsList)).toEqual({ s1: 'hello' });
      await call(IPC_CHANNELS.composerDraftsSave, 's1', '');
      expect(await call(IPC_CHANNELS.composerDraftsList)).toEqual({});
    });

    it('ignores unknown conversations, such as a new conversation not created yet, and malformed arguments', async () => {
      const { store, call } = await setup();
      await call(IPC_CHANNELS.composerDraftsSave, 'draft-123', 'not a session yet');
      await call(IPC_CHANNELS.composerDraftsSave, 's1', 42);
      await call(IPC_CHANNELS.composerDraftsSave, { id: 's1' }, 'text');
      await call(IPC_CHANNELS.composerDraftsSave, 'x'.repeat(SESSION_ID_MAX_LENGTH + 1), 'text');
      expect(store.all()).toEqual({});
    });

    it('accepts a known id of exactly the maximum length', async () => {
      const id = 'x'.repeat(SESSION_ID_MAX_LENGTH);
      const { store, call } = await setup([id]);
      await call(IPC_CHANNELS.composerDraftsSave, id, 'text');
      expect(store.all()).toEqual({ [id]: 'text' });
    });

    it('applies saves in the order they arrive, even when a session lookup is slow', async () => {
      let lookups = 0;
      const { store, call } = await setup([], async () => {
        lookups += 1;
        // The first keystroke's lookup finishes last.
        await new Promise(resolve => setTimeout(resolve, lookups === 1 ? 20 : 0));
        return true;
      });
      await Promise.all([
        call(IPC_CHANNELS.composerDraftsSave, 's1', 'h'),
        call(IPC_CHANNELS.composerDraftsSave, 's1', 'he'),
        call(IPC_CHANNELS.composerDraftsSave, 's1', 'hey'),
      ]);
      expect(store.all()).toEqual({ s1: 'hey' });
      // Once a draft is stored, later keystrokes skip the lookup.
      expect(lookups).toBe(1);
    });
  });
});

describe('generationIpc', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  async function setup() {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-generation-ipc-'));
    roots.push(directory);
    const store = new SessionStore(directory, 'test-model');
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerGenerationIpc(
      {
        handle: (channel: string, listener: (...args: never[]) => unknown) =>
          void handlers.set(channel, listener as never),
      },
      { setSessionGeneration: (id, generation) => store.setGeneration(id, generation) }
    );
    const set = (...args: unknown[]) => handlers.get(IPC_CHANNELS.chatSetSessionGeneration)?.({ sender: {} }, ...args);
    const session = await store.create();
    await store.setGeneration(session.id, { temperature: 0.4, topK: 40 });
    return { store, set, id: session.id };
  }

  describe('registerGenerationIpc', () => {
    it('stores a valid set and clears on an empty one', async () => {
      const { store, set, id } = await setup();
      expect(await set(id, { topP: 0.9 })).toMatchObject({ id, generation: { topP: 0.9 } });
      await set(id, {});
      expect((await store.get(id))?.generation).toBeUndefined();
    });

    it.each([null, 'hot', { temperature: 50 }, { topK: 1e9 }, { temperature: 0.2, topP: '0.9' }, { temperatur: 0.5 }])(
      'leaves the stored overrides alone for %j',
      async generation => {
        const { store, set, id } = await setup();
        expect(await set(id, generation)).toBeNull();
        expect((await store.get(id))?.generation).toEqual({ temperature: 0.4, topK: 40 });
      }
    );

    it('answers null for a session id that is not a string', async () => {
      const { set } = await setup();
      expect(await set(42, { topP: 0.9 })).toBeNull();
    });
  });
});

describe('historyIpc', () => {
  function setup(available = true) {
    const service = {
      setSessionHistory: vi.fn(async () => null),
      searchHistory: vi.fn(() => []),
    };
    const history = { clear: vi.fn(() => ({ entries: 0 })), state: vi.fn(() => ({ entries: 7 })) };
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerHistoryIpc(
      {
        handle: (channel, listener) => {
          handlers.set(channel, listener as (...args: unknown[]) => unknown);
        },
      },
      service,
      available ? history : undefined
    );
    const call = (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Handler not registered: ${channel}`);
      return handler({}, ...args);
    };
    return { service, history, call };
  }

  describe('local history IPC', () => {
    it('forwards opt-in and opt-out to the service with their exact session identity', async () => {
      const { service, call } = setup();
      await call(IPC_CHANNELS.chatSetSessionHistory, 'first', true);
      expect(service.setSessionHistory).toHaveBeenLastCalledWith('first', true);
      await call(IPC_CHANNELS.chatSetSessionHistory, 'second', false);
      expect(service.setSessionHistory).toHaveBeenLastCalledWith('second', false);
    });

    it('rejects malformed input without changing the session or coercing objects into searches', () => {
      const { service, call } = setup();
      expect(() => call(IPC_CHANNELS.chatSetSessionHistory, 'first', 'false')).toThrow();
      expect(() => call(IPC_CHANNELS.chatSetSessionHistory, '', true)).toThrow();
      expect(() => call(IPC_CHANNELS.chatSearchHistory, {})).toThrow();
      expect(service.setSessionHistory).not.toHaveBeenCalled();
      expect(service.searchHistory).not.toHaveBeenCalled();
    });

    it('forwards queries and exposes the real scoped count and clear result', () => {
      const { service, history, call } = setup();
      expect(call(IPC_CHANNELS.chatSearchHistory, 'moon launch')).toEqual([]);
      expect(service.searchHistory).toHaveBeenLastCalledWith('moon launch');
      expect(call(IPC_CHANNELS.chatHistoryState)).toEqual({ entries: 7 });
      expect(history.state).toHaveBeenCalledTimes(1);
      expect(call(IPC_CHANNELS.chatClearHistory)).toEqual({ entries: 0 });
      expect(history.clear).toHaveBeenCalledTimes(1);
    });

    it('reports unavailable storage instead of claiming a successful clear or an empty index', () => {
      const { call } = setup(false);
      expect(() => call(IPC_CHANNELS.chatClearHistory)).toThrow('Local history is unavailable');
      expect(() => call(IPC_CHANNELS.chatHistoryState)).toThrow('Local history is unavailable');
    });

    it('propagates storage failures instead of reporting success', () => {
      const { history, call } = setup();
      history.clear.mockImplementation(() => {
        throw new Error('disk failure');
      });
      expect(() => call(IPC_CHANNELS.chatClearHistory)).toThrow('disk failure');
    });
  });
});

describe('localContextIpc', () => {
  async function setup() {
    const file = join(await mkdtemp(join(tmpdir(), 'b4m-local-context-ipc-')), 'local-context.json');
    const forget = vi.fn();
    const fit = vi.fn(async () => ({ 262144: ['qwen3:8b'] }));
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerLocalContextIpc(
      {
        handle: (channel: string, listener: (...args: never[]) => unknown) =>
          void handlers.set(channel, listener as never),
      },
      { preference: new LocalContextPreference(file), forget, fit }
    );
    const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({ sender: {} }, ...args);
    return { file, forget, fit, call };
  }

  describe('registerLocalContextIpc', () => {
    it('saves a fixed size and makes every model size itself again', async () => {
      const { file, forget, call } = await setup();
      expect(await call(IPC_CHANNELS.chatSetLocalContext, { mode: 'fixed', tokens: 65536 })).toEqual({
        mode: 'fixed',
        tokens: 65536,
      });
      expect(forget).toHaveBeenCalledOnce();
      expect(await call(IPC_CHANNELS.chatGetLocalContext)).toEqual({ mode: 'fixed', tokens: 65536 });
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ mode: 'fixed', tokens: 65536 });
    });

    it.each([
      null,
      'fixed',
      42,
      { mode: 'fixed', tokens: 1234 },
      { mode: 'fixed', tokens: '65536' },
      { mode: 'turbo' },
    ])('reads garbage from the renderer as Auto: %j', async input => {
      const { forget, call } = await setup();
      expect(await call(IPC_CHANNELS.chatSetLocalContext, input)).toEqual({ mode: 'auto' });
      expect(await call(IPC_CHANNELS.chatGetLocalContext)).toEqual({ mode: 'auto' });
      expect(forget).toHaveBeenCalledOnce();
    });

    it('answers which sizes may not fit', async () => {
      const { fit, call } = await setup();
      expect(await call(IPC_CHANNELS.chatGetLocalContextFit)).toEqual({ 262144: ['qwen3:8b'] });
      expect(fit).toHaveBeenCalledOnce();
    });
  });
});

describe('orchestrationIpc', () => {
  it('validates policy and task actions at the renderer boundary and keeps model reports out of IPC', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const service = {
      getRolePolicy: vi.fn(async () => inheritancePolicy()),
      setRolePolicy: vi.fn(async () => inheritancePolicy()),
      actOnTask: vi.fn(),
      listTaskDecisions: vi.fn(async () => []),
    };
    registerOrchestrationIpc(
      {
        handle: (channel, listener) => {
          handlers.set(channel, listener as (...args: unknown[]) => unknown);
        },
      },
      service
    );
    const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
    const policy = inheritancePolicy();
    await call(IPC_CHANNELS.chatSetRolePolicy, policy);
    expect(service.setRolePolicy).toHaveBeenLastCalledWith(policy);
    expect(() => call(IPC_CHANNELS.chatSetRolePolicy, { ...policy, version: 2 })).toThrow();
    expect(service.setRolePolicy).toHaveBeenCalledTimes(1);
    const id = 'f3708bc5-9424-4d0c-8a18-41f166cb43a1';
    await call(IPC_CHANNELS.chatTaskAction, id, { kind: 'cancel', reason: 'Canceled' });
    expect(service.actOnTask).toHaveBeenLastCalledWith(null, id, { kind: 'cancel', reason: 'Canceled' });
    expect(() => call(IPC_CHANNELS.chatTaskAction, '../other', { kind: 'cancel', reason: 'Invalid' })).toThrow();
    expect(() =>
      call(IPC_CHANNELS.chatTaskAction, id, {
        kind: 'report',
        report: { status: 'blocked', reason: 'Forged', evidence: ['Model text'] },
      })
    ).toThrow(/worker/);
    expect(service.actOnTask).toHaveBeenCalledTimes(1);
  });
});

describe('sessionCreateIpc', () => {
  const created = { id: 'fresh', title: 'fresh' } as ChatSessionSummary;
  const placed = { sections: [{ id: 's1', name: 'Work' }], assignments: { fresh: 's1' } };

  function setup(overrides: Partial<SessionCreation> = {}) {
    const creation: SessionCreation = {
      createSession: vi.fn(() => Promise.resolve(created)),
      place: vi.fn(() => Promise.resolve({ sections: placed, failed: false })),
      ...overrides,
    };
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerSessionCreateIpc(
      {
        handle: (channel: string, listener: (...args: never[]) => unknown) =>
          void handlers.set(channel, listener as never),
      },
      creation
    );
    const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
    return { creation, call };
  }

  describe('session create IPC handlers', () => {
    it('files a new Chat session in the requested section and answers the sidebar state', async () => {
      const { creation, call } = setup();

      await expect(call(IPC_CHANNELS.chatCreateSession, { sectionId: 's1' })).resolves.toEqual({
        session: created,
        sidebarSections: placed,
      });

      expect(creation.place).toHaveBeenCalledWith('fresh', 's1');
    });

    it('creates a Chat session without a section when none is asked for', async () => {
      const { creation, call } = setup();

      await call(IPC_CHANNELS.chatCreateSession);

      expect(creation.place).toHaveBeenCalledWith('fresh', undefined);
    });

    it('still answers the session when its section could not be saved', async () => {
      const { call } = setup({ place: vi.fn(() => Promise.resolve({ failed: true })) });

      await expect(call(IPC_CHANNELS.chatCreateSession, { sectionId: 's1' })).resolves.toEqual({
        session: created,
        placementFailed: true,
      });
    });
  });
});

describe('sessionExportIpc', () => {
  const SESSION = {
    id: 'session-1',
    title: 'A/B notes',
    model: 'test-model',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    mode: 'chat',
    messages: [{ id: 'm1', role: 'user', content: 'hello there', createdAt: '2026-10-01T00:00:00.000Z' }],
  } as unknown as ChatSession;

  async function setup() {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-session-export-'));
    const deps = {
      sessions: { get: vi.fn(async (id: string) => (id === SESSION.id ? SESSION : null)) },
      pickSavePath: vi.fn(async (_sender: unknown, _options: unknown): Promise<string | null> => null),
      writeFile: vi.fn(async (_path: string, _content: string) => {}),
      downloadsDirectory: () => join(directory, 'Downloads'),
    };
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerSessionExportIpc(
      {
        handle: (channel: string, listener: (...args: never[]) => unknown) =>
          void handlers.set(channel, listener as never),
      },
      deps
    );
    const exportSession = (sessionId: unknown) =>
      handlers.get(IPC_CHANNELS.chatExportSession)!({ sender: {} }, sessionId) as Promise<ChatSessionExportResult>;
    return { directory, deps, exportSession };
  }

  describe('chat:export-session', () => {
    let ctx: Awaited<ReturnType<typeof setup>>;
    beforeEach(async () => {
      ctx = await setup();
    });

    it('offers a sanitized .md name in Downloads with both formats', async () => {
      await ctx.exportSession(SESSION.id);
      expect(ctx.deps.pickSavePath).toHaveBeenCalledWith(expect.anything(), {
        defaultPath: join(ctx.directory, 'Downloads', 'A-B notes.md'),
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'JSON', extensions: ['json'] },
        ],
      });
    });

    it('writes nothing and reports not saved when the dialog is cancelled', async () => {
      await expect(ctx.exportSession(SESSION.id)).resolves.toEqual({ saved: false });
      expect(ctx.deps.writeFile).not.toHaveBeenCalled();
    });

    it('writes the stored record as JSON for a .json path', async () => {
      const path = join(ctx.directory, 'out.JSON');
      ctx.deps.pickSavePath.mockResolvedValueOnce(path);
      ctx.deps.writeFile.mockImplementationOnce(async (to, content) => {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(to, content, 'utf8');
      });
      await expect(ctx.exportSession(SESSION.id)).resolves.toEqual({ saved: true, path });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(SESSION);
    });

    it('writes Markdown for a .md path and for any other extension', async () => {
      ctx.deps.pickSavePath.mockResolvedValueOnce('/x/notes.md').mockResolvedValueOnce('/x/notes.txt');
      await ctx.exportSession(SESSION.id);
      await ctx.exportSession(SESSION.id);
      for (const [, content] of ctx.deps.writeFile.mock.calls) {
        expect(content.startsWith('# A/B notes\n')).toBe(true);
        expect(content).toContain('## User\n\nhello there');
      }
    });

    it('rejects an unknown session, a malformed id, and a failed write', async () => {
      await expect(ctx.exportSession('missing')).rejects.toThrow('no longer exists');
      await expect(ctx.exportSession(42)).rejects.toThrow('Not a notebook id');
      await expect(ctx.exportSession('../etc')).rejects.toThrow('Not a notebook id');
      expect(ctx.deps.pickSavePath).not.toHaveBeenCalled();

      ctx.deps.pickSavePath.mockResolvedValueOnce('/x/notes.md');
      ctx.deps.writeFile.mockRejectedValueOnce(new Error('disk full'));
      await expect(ctx.exportSession(SESSION.id)).rejects.toThrow('disk full');
    });
  });
});

describe('sessionOrchestrateIpc', () => {
  function setup() {
    const summary = { id: 's1', orchestrate: true } as ChatSessionSummary;
    const setSessionOrchestrate = vi.fn(() => Promise.resolve(summary));
    const raiseRunBudget = vi.fn(() => Promise.resolve({ ok: true as const, resumed: 1 }));
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerSessionOrchestrateIpc(
      {
        handle: (channel: string, listener: (...args: never[]) => unknown) =>
          void handlers.set(channel, listener as never),
      },
      { setSessionOrchestrate, raiseRunBudget }
    );
    const call = (...args: unknown[]) => handlers.get(IPC_CHANNELS.chatSetSessionOrchestrate)?.({}, ...args);
    const raise = (...args: unknown[]) => handlers.get(IPC_CHANNELS.chatRaiseRunBudget)?.({}, ...args);
    return { summary, setSessionOrchestrate, raiseRunBudget, call, raise };
  }

  describe('session orchestrate IPC handler', () => {
    it('passes a boolean through to the service', async () => {
      const { summary, setSessionOrchestrate, call } = setup();

      expect(await call('s1', true)).toBe(summary);
      await call('s1', false);

      expect(setSessionOrchestrate.mock.calls).toEqual([
        ['s1', true],
        ['s1', false],
      ]);
    });

    it('answers null and writes nothing for a value that is not a boolean, or an id that is not a string', async () => {
      const { setSessionOrchestrate, call } = setup();

      const answers = await Promise.all([
        call('s1', 'true'),
        call('s1', 1),
        call('s1', undefined),
        call('s1', null),
        call(42, true),
      ]);

      expect(answers).toEqual([null, null, null, null, null]);
      expect(setSessionOrchestrate).not.toHaveBeenCalled();
    });

    it('passes a positive whole budget through and refuses any other', async () => {
      const { summary, setSessionOrchestrate, call } = setup();

      expect(await call('s1', true, 500)).toBe(summary);
      expect(await Promise.all([call('s1', true, 0), call('s1', true, 1.5), call('s1', true, '500')])).toEqual([
        null,
        null,
        null,
      ]);

      expect(setSessionOrchestrate.mock.calls).toEqual([['s1', true, 500]]);
    });

    it('raises a run budget only for a positive whole number of credits', async () => {
      const { raiseRunBudget, raise } = setup();

      expect(await raise('s1', 2000)).toEqual({ ok: true, resumed: 1 });
      expect(await raise('s1', -5)).toEqual({ ok: false, error: 'Enter a whole number of credits.' });
      expect(await raise(7, 2000)).toEqual({ ok: false, error: 'Enter a whole number of credits.' });

      expect(raiseRunBudget.mock.calls).toEqual([['s1', 2000]]);
    });
  });
});

describe('sidebarIpc', () => {
  const current = { sections: [{ id: 's1', name: 'Work' }], assignments: {} };

  function setup(known: (sessionId: string) => boolean = () => true) {
    const store = {
      read: vi.fn(() => Promise.resolve(current)),
      create: vi.fn(() => Promise.resolve(current)),
      rename: vi.fn(() => Promise.resolve(current)),
      remove: vi.fn(() => Promise.resolve(current)),
      move: vi.fn(() => Promise.resolve(current)),
    };
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerSidebarIpc(
      {
        handle: (channel: string, listener: (...args: never[]) => unknown) =>
          void handlers.set(channel, listener as never),
      },
      store as unknown as SidebarSectionStore,
      sessionId => Promise.resolve(known(sessionId))
    );
    const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
    return { store, call };
  }

  describe('sidebar IPC handlers', () => {
    it('answers a non-string argument with the current state and writes nothing', async () => {
      const { store, call } = setup();

      const answers = await Promise.all([
        call(IPC_CHANNELS.sidebarCreateSection, 42),
        call(IPC_CHANNELS.sidebarRenameSection, 'a', {}),
        call(IPC_CHANNELS.sidebarRenameSection, null, 'x'),
        call(IPC_CHANNELS.sidebarDeleteSection, 7),
        call(IPC_CHANNELS.sidebarMoveSession, 1, 'a'),
        call(IPC_CHANNELS.sidebarMoveSession, 'a', 5),
      ]);

      expect(answers).toEqual(answers.map(() => current));
      expect(store.create).not.toHaveBeenCalled();
      expect(store.rename).not.toHaveBeenCalled();
      expect(store.remove).not.toHaveBeenCalled();
      expect(store.move).not.toHaveBeenCalled();
      expect(store.read).toHaveBeenCalledTimes(answers.length);
    });

    it('passes valid arguments through, including a null section on move', async () => {
      const { store, call } = setup();

      await call(IPC_CHANNELS.sidebarCreateSection, 'Work', 5);
      await call(IPC_CHANNELS.sidebarMoveSession, 'a', null);

      expect(store.create).toHaveBeenCalledWith('Work', undefined);
      expect(store.move).toHaveBeenCalledWith('a', null);
    });

    it('refuses a session id over the length cap', async () => {
      const { store, call } = setup();
      const long = 'x'.repeat(SIDEBAR_SESSION_ID_MAX_LENGTH + 1);

      expect(await call(IPC_CHANNELS.sidebarMoveSession, long, 's1')).toBe(current);
      await call(IPC_CHANNELS.sidebarCreateSection, 'Work', long);

      expect(store.move).not.toHaveBeenCalled();
      expect(store.create).toHaveBeenCalledWith('Work', undefined);
    });
    it('assigns only sessions that exist, but still lets any id leave its section', async () => {
      const { store, call } = setup(sessionId => sessionId === 'real');

      expect(await call(IPC_CHANNELS.sidebarMoveSession, 'made-up', 's1')).toBe(current);
      await call(IPC_CHANNELS.sidebarCreateSection, 'Work', 'made-up');
      await call(IPC_CHANNELS.sidebarMoveSession, 'made-up', null);
      await call(IPC_CHANNELS.sidebarMoveSession, 'real', 's1');

      expect(store.create).toHaveBeenCalledWith('Work', undefined);
      expect(store.move.mock.calls).toEqual([
        ['made-up', null],
        ['real', 's1'],
      ]);
    });
  });

  describe('placeNewSession', () => {
    it('moves the new session into the section asked for and answers the state', async () => {
      const placed = { sections: current.sections, assignments: { fresh: 's1' } };
      const store = { move: vi.fn(() => Promise.resolve(placed)) };
      const onError = vi.fn();

      await expect(placeNewSession(store, 'fresh', 's1', onError)).resolves.toEqual({
        sections: placed,
        failed: false,
      });

      expect(store.move).toHaveBeenCalledWith('fresh', 's1');
      expect(onError).not.toHaveBeenCalled();
    });

    it.each([undefined, null, 42, {}])('writes nothing when the section is %j', async sectionId => {
      const store = { move: vi.fn(() => Promise.resolve(current)) };

      await expect(placeNewSession(store, 'fresh', sectionId, vi.fn())).resolves.toEqual({ failed: false });

      expect(store.move).not.toHaveBeenCalled();
    });

    it('reports a failed write and marks the placement failed, so the create still succeeds', async () => {
      const failure = new Error('disk full');
      const store = { move: vi.fn(() => Promise.reject(failure)) };
      const onError = vi.fn();

      await expect(placeNewSession(store, 'fresh', 's1', onError)).resolves.toEqual({ failed: true });

      expect(onError).toHaveBeenCalledWith(failure);
    });
  });
});

describe('spawnLocationIpc', () => {
  async function setup() {
    const file = join(await mkdtemp(join(tmpdir(), 'b4m-spawn-location-ipc-')), 'spawn-location.json');
    const broadcast = vi.fn();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerSpawnLocationIpc(
      {
        handle: (channel: string, listener: (...args: never[]) => unknown) =>
          void handlers.set(channel, listener as never),
      },
      { preference: new SpawnLocationPreference(file), broadcast }
    );
    const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({ sender: {} }, ...args);
    return { file, broadcast, call };
  }

  describe('registerSpawnLocationIpc', () => {
    it('answers the default before anything is saved', async () => {
      const { call } = await setup();
      expect(await call(IPC_CHANNELS.chatGetSpawnLocation)).toBe('worktree');
    });

    it('saves a location and tells every window', async () => {
      const { file, broadcast, call } = await setup();
      expect(await call(IPC_CHANNELS.chatSetSpawnLocation, 'local')).toBe('local');
      expect(broadcast).toHaveBeenCalledWith('local');
      expect(await call(IPC_CHANNELS.chatGetSpawnLocation)).toBe('local');
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ location: 'local' });
    });

    it.each([null, 'here', 42, { location: 'ask' }])(
      'reads garbage from the renderer as the default: %j',
      async input => {
        const { broadcast, call } = await setup();
        expect(await call(IPC_CHANNELS.chatSetSpawnLocation, input)).toBe('worktree');
        expect(broadcast).toHaveBeenCalledWith('worktree');
      }
    );
  });
});

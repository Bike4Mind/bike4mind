import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { STREAM_THROTTLE_MS, WatchService, type WatchSources } from './WatchService';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_WATCH_PREFERENCES,
  EMPTY_WATCH_SNAPSHOT,
  QUICK_SUMMARY_MAX,
  type WatchOrchestration,
  type WatchSnapshot,
} from '@shared/watch';
import { WatchPreferencesStore } from './WatchPreferencesStore';
import {
  TRAY_LABEL_MAX,
  needsYouTitle,
  trayPresentation,
  truncateLabel,
  type TrayPresentation,
} from './trayPresentation';
import type { ChatMessage, ChatSessionStatusEvent, ChatSessionSummary, ChatToolCall } from '@shared/chat';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  trays: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  templates: [] as MenuItemConstructorOptions[][],
  menuListeners: [] as Array<() => void>,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => electron.handlers.set(channel, handler),
  },
  Tray: vi.fn(function Tray() {
    const tray = {
      setImage: vi.fn(),
      setTitle: vi.fn(),
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      popUpContextMenu: vi.fn(),
      on: vi.fn(),
      destroy: vi.fn(),
    };
    electron.trays.push(tray);
    return tray;
  }),
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      electron.templates.push(template);
      return { on: (_event: string, listener: () => void) => electron.menuListeners.push(listener) };
    },
  },
}));

const { IPC_CHANNELS } = await import('@shared/ipc');
const { registerWatchIpc } = await import('./ipc');
const { createTrayController } = await import('./tray');

describe('WatchService', () => {
  const T0 = Date.parse('2026-11-12T10:00:00Z');

  function session(id: string, parentId: string | null): ChatSessionSummary {
    return {
      id,
      title: `Title ${id}`,
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
      messageCount: 1,
      ...(parentId ? { origin: { parentSessionId: parentId } } : {}),
    } as ChatSessionSummary;
  }

  function waitingMessage(approvalId: string, extra: Partial<ChatToolCall> = {}): ChatMessage {
    return {
      id: `m-${approvalId}`,
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: `c-${approvalId}`,
          name: 'bash',
          input: { command: 'ls' },
          status: 'awaiting-approval',
          approvalId,
          approvalDetail: '$ ls',
          ...extra,
        },
      ],
    } as unknown as ChatMessage;
  }

  function setup(overrides: Partial<WatchSources> = {}) {
    let sessions = [session('root', null), session('a', 'root')];
    const messages = new Map<string, ChatMessage[]>();
    const resolveApproval = vi.fn();
    const warn = vi.fn();
    const service = new WatchService({
      listSessions: async () => sessions,
      sessionStatuses: () => [],
      sessionMessages: async id => messages.get(id) ?? [],
      resolveApproval,
      warn,
      now: () => T0,
      ...overrides,
    });
    const status = async (sessionId: string, value: ChatSessionStatusEvent['status']) => {
      service.observeStatus({ sessionId, status: value });
      await service.settled();
    };
    return {
      service,
      messages,
      resolveApproval,
      warn,
      status,
      setSessions: (next: ChatSessionSummary[]) => {
        sessions = next;
      },
    };
  }

  describe('WatchService', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('reports an agent waiting on an approval, with the call to answer', async () => {
      const { service, messages, status } = setup();
      const listener = vi.fn();
      service.onChange(listener);
      messages.set('a', [waitingMessage('approval-1')]);
      await status('a', 'needs-action');

      const snapshot = service.snapshot();
      expect(snapshot.overall).toBe('needs-you');
      expect(snapshot.needsYouCount).toBe(1);
      expect(snapshot.pending).toEqual([
        expect.objectContaining({ approvalId: 'approval-1', sessionId: 'a', quick: true }),
      ]);
      expect(listener).toHaveBeenLastCalledWith(snapshot);
    });

    it('answers a quick approval through the approval gate, once only', async () => {
      const { service, messages, status, resolveApproval } = setup();
      messages.set('a', [waitingMessage('approval-1')]);
      await status('a', 'needs-action');

      await expect(service.respond('approval-1', 'once')).resolves.toBe(true);
      expect(resolveApproval).toHaveBeenCalledWith('approval-1', { decision: 'once' });
    });

    it('refuses an id that is not pending, or one that needs the full card', async () => {
      const { service, messages, status, resolveApproval } = setup();
      messages.set('a', [waitingMessage('risky', { approvalIrreversible: true })]);
      await status('a', 'needs-action');

      await expect(service.respond('risky', 'once')).resolves.toBe(false);
      await expect(service.respond('answered-in-app', 'deny')).resolves.toBe(false);
      expect(resolveApproval).not.toHaveBeenCalled();
    });

    it('drops an approval once its session stops waiting', async () => {
      const { service, messages, status } = setup();
      messages.set('a', [waitingMessage('approval-1')]);
      await status('a', 'needs-action');
      await status('a', 'processing');

      expect(service.snapshot().pending).toEqual([]);
      await expect(service.respond('approval-1', 'once')).resolves.toBe(false);
    });

    it('re-reads a waiting session when another call parks, and after an answer', async () => {
      const { service, messages, status } = setup();
      messages.set('a', [waitingMessage('approval-1')]);
      await status('a', 'needs-action');

      messages.set('a', [waitingMessage('approval-1'), waitingMessage('approval-2')]);
      service.observeStream({
        type: 'tool-start',
        sessionId: 'a',
        call: { id: 'c-approval-2', name: 'bash', input: { command: 'ls' }, status: 'awaiting-approval' },
      } as never);
      await service.settled();
      expect(service.snapshot().pending.map(item => item.approvalId)).toEqual(['approval-1', 'approval-2']);

      messages.set('a', [waitingMessage('approval-2')]);
      await service.respond('approval-1', 'once');
      await service.settled();
      expect(service.snapshot().pending.map(item => item.approvalId)).toEqual(['approval-2']);
    });

    it('counts a turn that started and ended before the rebuild ran', async () => {
      const { service } = setup();
      await service.settled();
      service.observeStatus({ sessionId: 'a', status: 'processing' });
      service.observeStatus({ sessionId: 'a', status: 'done' });
      await service.settled();
      expect(service.snapshot().overall).toBe('done');
    });

    it('is done after work finishes, until the user looks', async () => {
      const { service, status } = setup();
      await status('a', 'processing');
      expect(service.snapshot().overall).toBe('working');
      await status('a', 'done');
      expect(service.snapshot().overall).toBe('done');
      expect(service.snapshot().orchestrations[0].celebrate).toBe(true);

      service.acknowledge();
      await service.settled();
      expect(service.snapshot().overall).toBe('idle');
    });

    it('never calls an orchestration done that was idle from the start', async () => {
      const { service, status } = setup();
      await status('a', 'done');
      expect(service.snapshot().overall).toBe('idle');
    });

    it('throttles stream activity into one rebuild', async () => {
      const { service, status } = setup();
      await status('a', 'processing');
      const listener = vi.fn();
      service.onChange(listener);
      service.observeStream({ type: 'phase', sessionId: 'a', phase: { kind: 'thinking' } } as never);
      service.observeStream({
        type: 'tool-start',
        sessionId: 'a',
        call: { id: 'c', name: 'read_file', input: { path: 'src/index.ts' }, status: 'running' },
      } as never);
      expect(listener).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(STREAM_THROTTLE_MS);
      await service.settled();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(service.snapshot().orchestrations[0].agents[0].activity).toBe('read_file index.ts');
    });

    it('re-reads everything from the new scope after an account change', async () => {
      const { service, messages, status, setSessions } = setup();
      messages.set('a', [waitingMessage('approval-1')]);
      await status('a', 'needs-action');

      setSessions([]);
      service.scopeChanged();
      await service.settled();
      expect(service.snapshot().orchestrations).toEqual([]);
      expect(service.snapshot().overall).toBe('idle');
    });

    it('seeds statuses that were set before it started', async () => {
      const { service } = setup({ sessionStatuses: () => [{ sessionId: 'a', status: 'processing' }] });
      service.start();
      await service.settled();
      expect(service.snapshot().overall).toBe('working');
    });

    it('keeps going after a failed list read', async () => {
      const { service, warn } = setup({ listSessions: () => Promise.reject(new Error('disk')) });
      service.observeStatus({ sessionId: 'a', status: 'processing' });
      await service.settled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk'));
    });
  });
});

describe('WatchPreferencesStore', () => {
  async function fileIn(): Promise<string> {
    return join(await mkdtemp(join(tmpdir(), 'watch-prefs-')), 'watch-preferences.json');
  }

  describe('WatchPreferencesStore', () => {
    it('starts from the defaults when there is no file, or a corrupt one', async () => {
      const path = await fileIn();
      expect(await new WatchPreferencesStore(path).load()).toEqual(DEFAULT_WATCH_PREFERENCES);
      await writeFile(path, '{not json');
      expect(await new WatchPreferencesStore(path).load()).toEqual(DEFAULT_WATCH_PREFERENCES);
    });

    it('round-trips an update through an owner-only file', async () => {
      const path = await fileIn();
      const store = new WatchPreferencesStore(path);
      await store.load();
      await store.update({ miniOpen: true, miniBounds: { x: 5, y: 6, width: 360, height: 220 } });
      await store.update({ showInMenuBar: false });

      const reloaded = await new WatchPreferencesStore(path).load();
      expect(reloaded).toEqual({
        showInMenuBar: false,
        miniOpen: true,
        miniBounds: { x: 5, y: 6, width: 360, height: 220 },
      });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(reloaded);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    });

    it('serves the latest value from memory before the write lands', async () => {
      const store = new WatchPreferencesStore(await fileIn());
      await store.load();
      const write = store.update({ miniOpen: true });
      expect(store.current().miniOpen).toBe(true);
      await write;
    });
  });
});

describe('trayPresentation', () => {
  function orchestration(overrides: Partial<WatchOrchestration> = {}): WatchOrchestration {
    return {
      rootId: 'root',
      title: 'Ship the release',
      agents: [
        { id: 'a', title: 'Tests', state: 'needs-you', activity: null },
        { id: 'b', title: 'Docs', state: 'working', activity: 'read_file README.md' },
      ],
      sessions: [],
      statuses: {},
      activity: {},
      lastActiveAt: 0,
      needsYouSince: 1,
      celebrate: false,
      ...overrides,
    };
  }

  const busy: WatchSnapshot = {
    overall: 'needs-you',
    needsYouCount: 1,
    orchestrations: [orchestration()],
    pending: [
      {
        approvalId: 'approval-1',
        sessionId: 'a',
        rootId: 'root',
        agentTitle: 'Tests',
        orchestrationTitle: 'Ship the release',
        summary: 'bash pnpm test',
        quick: true,
        since: 1,
      },
    ],
  };

  describe('needsYouTitle', () => {
    it('says nothing unless someone needs you', () => {
      expect(needsYouTitle(0)).toBe('');
      expect(needsYouTitle(1)).toBe('1 needs you');
      expect(needsYouTitle(3)).toBe('3 need you');
    });
  });

  describe('trayPresentation', () => {
    it('maps each overall state to its icon, with words only for needs-you', () => {
      for (const overall of ['idle', 'working', 'done'] as const) {
        const presentation = trayPresentation({ ...busy, overall, needsYouCount: 0, pending: [] }, false);
        expect(presentation.icon).toBe(overall);
        expect(presentation.title).toBe('');
      }
      const needsYou = trayPresentation(busy, false);
      expect(needsYou.icon).toBe('needs-you');
      expect(needsYou.title).toBe('1 needs you');
      expect(needsYou.tooltip).toBe('Bike4Mind - 1 needs you');
    });

    it('lists approvals first, then each orchestration with its agents', () => {
      const { items } = trayPresentation(busy, false);
      expect(items.map(item => item.kind)).toEqual([
        'header',
        'separator',
        'approval',
        'separator',
        'orchestration',
        'separator',
        'action',
        'action',
        'action',
      ]);
      expect(items[0]).toEqual({ kind: 'header', label: '2 agents: 1 needs you, 1 working' });
      expect(items[2]).toMatchObject({
        kind: 'approval',
        approvalId: 'approval-1',
        label: 'Tests: bash pnpm test',
        quick: true,
      });
      expect(items[4]).toMatchObject({
        kind: 'orchestration',
        label: 'Ship the release',
        agents: [
          { sessionId: 'a', label: '\u25CF Tests' },
          { sessionId: 'b', label: '\u25D0 Docs - read_file README.md' },
        ],
      });
    });

    it('flips the mini window action with its visibility', () => {
      const label = (miniOpen: boolean) =>
        trayPresentation(busy, miniOpen).items.find(item => item.kind === 'action' && item.action === 'toggle-mini');
      expect(label(false)).toMatchObject({ label: 'Show mini Tavern' });
      expect(label(true)).toMatchObject({ label: 'Hide mini Tavern' });
    });

    it('lists the Orchestrate mini window toggle, before hiding the item, only when that window is wired', () => {
      const actions = (orchestrateMiniOpen?: boolean) =>
        trayPresentation(busy, false, orchestrateMiniOpen).items.flatMap(item =>
          item.kind === 'action' ? [[item.action, item.label]] : []
        );
      expect(actions().map(([action]) => action)).not.toContain('toggle-orchestrate-mini');
      expect(actions(false).slice(-2)).toEqual([
        ['toggle-orchestrate-mini', 'Show Orchestrate mini window'],
        ['hide-tray', 'Hide menu-bar item'],
      ]);
      expect(actions(true)).toContainEqual(['toggle-orchestrate-mini', 'Hide Orchestrate mini window']);
    });

    it('shows only the summary and the actions when nothing runs', () => {
      const { items, icon } = trayPresentation(EMPTY_WATCH_SNAPSHOT, false);
      expect(icon).toBe('idle');
      expect(items.map(item => (item.kind === 'action' ? item.action : item.kind))).toEqual([
        'header',
        'separator',
        'open-tavern',
        'toggle-mini',
        'hide-tray',
      ]);
    });
  });

  describe('approval rows', () => {
    const summary = `bash $ ${'x'.repeat(QUICK_SUMMARY_MAX - 'bash $ '.length)}`;
    const withPending = (quick: boolean) =>
      trayPresentation(
        {
          ...busy,
          pending: [{ ...busy.pending[0], agentTitle: 'A very long agent title that goes on', summary, quick }],
        },
        false
      ).items.find(item => item.kind === 'approval');

    it('cuts only the agent name from a quick approval, never its summary', () => {
      const row = withPending(true);
      expect(row?.kind === 'approval' && row.label.endsWith(`: ${summary}`)).toBe(true);
    });

    it('cuts a non-quick row to the menu width, since it only opens the app card', () => {
      const row = withPending(false);
      expect(row?.kind === 'approval' && row.label.length).toBe(TRAY_LABEL_MAX);
    });
  });

  describe('truncateLabel', () => {
    it('keeps menu lines on one short line', () => {
      expect(truncateLabel('a\n  b')).toBe('a b');
      const long = truncateLabel('x'.repeat(200));
      expect(long).toHaveLength(TRAY_LABEL_MAX);
      expect(long.endsWith('\u2026')).toBe(true);
    });
  });
});

describe('tray', () => {
  const images = { idle: 'idle', working: 'working', 'needs-you': 'needs-you', done: 'done' } as never;

  const needsYou: TrayPresentation = trayPresentation(
    {
      overall: 'needs-you',
      needsYouCount: 2,
      orchestrations: [
        {
          rootId: 'root',
          title: 'Root',
          agents: [{ id: 'a', title: 'Tests', state: 'needs-you', activity: null }],
          sessions: [],
          statuses: {},
          activity: {},
          lastActiveAt: 0,
          needsYouSince: 1,
          celebrate: false,
        },
      ],
      pending: [
        {
          approvalId: 'quick-1',
          sessionId: 'a',
          rootId: 'root',
          agentTitle: 'Tests',
          orchestrationTitle: 'Root',
          summary: 'bash ls',
          quick: true,
          since: 1,
        },
        {
          approvalId: 'risky-1',
          sessionId: 'a',
          rootId: 'root',
          agentTitle: 'Tests',
          orchestrationTitle: 'Root',
          summary: 'bash rm -rf build',
          quick: false,
          since: 2,
        },
      ],
    },
    false
  );

  function setup() {
    electron.trays.length = 0;
    electron.templates.length = 0;
    electron.menuListeners.length = 0;
    const handlers = { respond: vi.fn(), focus: vi.fn(), action: vi.fn(), menuOpened: vi.fn() };
    const controller = createTrayController(images, handlers);
    controller.render(needsYou);
    const template = () => electron.templates.at(-1) ?? [];
    const byLabel = (items: MenuItemConstructorOptions[], label: string) => items.find(item => item.label === label);
    const click = (item: MenuItemConstructorOptions | undefined) =>
      (item?.click as unknown as (() => void) | undefined)?.();
    return { handlers, controller, tray: electron.trays[0], template, byLabel, click };
  }

  describe('createTrayController', () => {
    const platform = process.platform;
    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: platform });
    });

    it('shows the state icon and the needs-you words on macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const { tray } = setup();
      expect(tray.setImage).toHaveBeenLastCalledWith('needs-you');
      expect(tray.setTitle).toHaveBeenLastCalledWith('2 need you');
      expect(tray.setToolTip).toHaveBeenLastCalledWith('Bike4Mind - 2 need you');
    });

    it('approves once and denies through the handlers', () => {
      const { handlers, template, byLabel, click } = setup();
      const approval = byLabel(template(), 'Tests: bash ls');
      const submenu = approval?.submenu as MenuItemConstructorOptions[];
      click(byLabel(submenu, 'Approve once'));
      click(byLabel(submenu, 'Deny'));
      expect(handlers.respond).toHaveBeenNthCalledWith(1, 'quick-1', 'once');
      expect(handlers.respond).toHaveBeenNthCalledWith(2, 'quick-1', 'deny');
    });

    it('sends a request that needs the full card to the app instead', () => {
      const { handlers, template, byLabel, click } = setup();
      const submenu = byLabel(template(), 'Tests: bash rm -rf build')?.submenu as MenuItemConstructorOptions[];
      expect(byLabel(submenu, 'Approve once')).toBeUndefined();
      click(submenu.find(item => item.label?.startsWith('Review in Bike4Mind')));
      expect(handlers.focus).toHaveBeenCalledWith({ sessionId: 'a', rootId: 'root' });
      expect(handlers.respond).not.toHaveBeenCalled();
    });

    it('focuses an agent from its orchestration, and runs the actions', () => {
      const { handlers, template, byLabel, click } = setup();
      const submenu = byLabel(template(), 'Root')?.submenu as MenuItemConstructorOptions[];
      click(submenu[0]);
      expect(handlers.focus).toHaveBeenCalledWith({ sessionId: 'a', rootId: 'root' });
      click(byLabel(template(), 'Show mini Tavern'));
      click(byLabel(template(), 'Hide menu-bar item'));
      expect(handlers.action).toHaveBeenNthCalledWith(1, 'toggle-mini');
      expect(handlers.action).toHaveBeenNthCalledWith(2, 'hide-tray');
    });

    it('acknowledges when the menu opens', () => {
      const { handlers } = setup();
      electron.menuListeners.at(-1)?.();
      expect(handlers.menuOpened).toHaveBeenCalledTimes(1);
    });

    it('does not rebuild the menu for an unchanged presentation', () => {
      const { controller } = setup();
      controller.render(needsYou);
      expect(electron.templates).toHaveLength(1);
      controller.render(trayPresentation(EMPTY_WATCH_SNAPSHOT, false));
      expect(electron.templates).toHaveLength(2);
    });

    it('sets no title outside macOS, and opens the menu on a left click there', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const { tray } = setup();
      expect(tray.setTitle).not.toHaveBeenCalled();
      expect(tray.on).toHaveBeenCalledWith('click', expect.any(Function));
    });

    it('removes the item on destroy', () => {
      const { controller, tray } = setup();
      controller.destroy();
      expect(tray.destroy).toHaveBeenCalled();
    });
  });
});

describe('ipc', () => {
  const mini = { id: 'mini' };
  const other = { id: 'main' };

  const snapshot: WatchSnapshot = {
    ...EMPTY_WATCH_SNAPSHOT,
    orchestrations: [
      {
        rootId: 'root',
        title: 'Root',
        agents: [{ id: 'a', title: 'A', state: 'needs-you', activity: null }],
        sessions: [],
        statuses: {},
        activity: {},
        lastActiveAt: 0,
        needsYouSince: 1,
        celebrate: false,
      },
    ],
  };

  function setup() {
    electron.handlers.clear();
    const deps = {
      snapshot: () => snapshot,
      respond: vi.fn(async () => true),
      openSession: vi.fn(),
      isMiniWindow: (sender: unknown) => sender === mini,
      closeMini: vi.fn(),
      preferences: () => DEFAULT_WATCH_PREFERENCES,
      setPreferences: vi.fn(async (patch: object) => ({ ...DEFAULT_WATCH_PREFERENCES, ...patch })),
    };
    registerWatchIpc(deps as never);
    const call = (channel: string, sender: object, ...args: unknown[]) =>
      electron.handlers.get(channel)?.({ sender }, ...args);
    return { deps, call };
  }

  describe('registerWatchIpc', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('serves the snapshot to the mini window only', async () => {
      const { call } = setup();
      expect(await call(IPC_CHANNELS.watchGetSnapshot, mini)).toBe(snapshot);
      expect(await call(IPC_CHANNELS.watchGetSnapshot, other)).toEqual(EMPTY_WATCH_SNAPSHOT);
    });

    it('answers approve-once and deny from the mini window', async () => {
      const { call, deps } = setup();
      expect(await call(IPC_CHANNELS.watchRespond, mini, 'approval-1', 'once')).toBe(true);
      expect(await call(IPC_CHANNELS.watchRespond, mini, 'approval-1', 'deny')).toBe(true);
      expect(deps.respond).toHaveBeenNthCalledWith(1, 'approval-1', 'once');
      expect(deps.respond).toHaveBeenNthCalledWith(2, 'approval-1', 'deny');
    });

    it.each([
      ['another window', other, 'approval-1', 'once'],
      ['an "always" decision', mini, 'approval-1', 'always'],
      ['a redirect', mini, 'approval-1', 'redirect'],
      ['a non-string id', mini, 42, 'once'],
      ['an empty id', mini, '', 'once'],
    ])('refuses %s', async (_label, sender, approvalId, decision) => {
      const { call, deps } = setup();
      expect(await call(IPC_CHANNELS.watchRespond, sender, approvalId, decision)).toBe(false);
      expect(deps.respond).not.toHaveBeenCalled();
    });

    it('focuses a watched agent through the notification path', async () => {
      const { call, deps } = setup();
      await call(IPC_CHANNELS.watchFocusAgent, mini, 'a', 'root');
      await call(IPC_CHANNELS.watchFocusAgent, mini, 'root', 'root');
      expect(deps.openSession).toHaveBeenNthCalledWith(1, { sessionId: 'a', rootId: 'root' });
      expect(deps.openSession).toHaveBeenNthCalledWith(2, { sessionId: 'root', rootId: 'root' });
    });

    it('ignores focus for sessions it is not watching, or from another window', async () => {
      const { call, deps } = setup();
      await call(IPC_CHANNELS.watchFocusAgent, mini, 'stranger', 'root');
      await call(IPC_CHANNELS.watchFocusAgent, mini, 'a', 'other-root');
      await call(IPC_CHANNELS.watchFocusAgent, other, 'a', 'root');
      expect(deps.openSession).not.toHaveBeenCalled();
    });

    it('closes only when the mini window itself asks', async () => {
      const { call, deps } = setup();
      await call(IPC_CHANNELS.watchCloseMini, other);
      expect(deps.closeMini).not.toHaveBeenCalled();
      await call(IPC_CHANNELS.watchCloseMini, mini);
      expect(deps.closeMini).toHaveBeenCalledTimes(1);
    });

    it('lets Settings change the menu-bar toggle and nothing else', async () => {
      const { call, deps } = setup();
      await call(IPC_CHANNELS.watchSetPreferences, other, { showInMenuBar: false });
      expect(deps.setPreferences).toHaveBeenCalledWith({ showInMenuBar: false });
      await call(IPC_CHANNELS.watchSetPreferences, other, { miniBounds: { x: 0, y: 0, width: 1, height: 1 } });
      await call(IPC_CHANNELS.watchSetPreferences, other, 'nope');
      expect(deps.setPreferences).toHaveBeenCalledTimes(1);
    });
  });
});

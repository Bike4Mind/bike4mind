import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeedsYouMonitor, type NeedsYouMonitorDeps } from './needsYouMonitor';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { NotifyScopeStore } from './NotifyScopeStore';
import type { ChatSessionSummary, ChatMessage } from '@shared/chat';
import type { AttentionNotice, NotifyScope } from '@shared/attention';

type Handler = (event: unknown, value?: unknown) => unknown;
type Listener = () => void;

const electron = vi.hoisted(() => {
  const shown: Array<{ options: { title: string; body: string }; emit(name: string): void; close: () => void }> = [];
  class Notification {
    static isSupported = vi.fn(() => true);
    private listeners = new Map<string, Listener>();
    close = vi.fn(() => this.emit('close'));
    constructor(public options: { title: string; body: string }) {}
    on(name: string, listener: Listener) {
      this.listeners.set(name, listener);
      return this;
    }
    show() {
      shown.push(this);
    }
    emit(name: string) {
      this.listeners.get(name)?.();
    }
  }
  return {
    shown,
    handlers: new Map<string, Handler>(),
    Notification,
    appListeners: new Map<string, (event: unknown, created: unknown) => void>(),
    app: {
      dock: { setBadge: vi.fn() },
      setBadgeCount: vi.fn(),
      on: vi.fn((name: string, listener: (event: unknown, created: unknown) => void) => {
        electron.appListeners.set(name, listener);
      }),
    },
    ipcMain: { handle: vi.fn() },
  };
});

const window = vi.hoisted(() => ({
  isFocused: vi.fn(() => false),
  isMinimized: vi.fn(() => false),
  isDestroyed: vi.fn(() => false),
  restore: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  webContents: { send: vi.fn() },
}));

const windows = vi.hoisted(() => ({ open: [] as unknown[] }));

vi.mock('electron', () => electron);
vi.mock('../windows', () => ({ appWindows: () => windows.open }));

const { registerAttention } = await import('./index');

describe('registerAttention', () => {
  const openWindow = vi.fn();
  let attention: ReturnType<typeof registerAttention>;

  const notice = { sessionId: 'agent-1', rootId: 'root-1', title: 'Brannoc needs you', body: 'bash rm -rf' };
  const call = (channel: string, value?: unknown) => electron.handlers.get(channel)?.({}, value);
  const originalPlatform = process.platform;
  const setPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform });

  beforeEach(() => {
    vi.clearAllMocks();
    electron.shown.length = 0;
    electron.handlers.clear();
    electron.ipcMain.handle.mockImplementation((channel: string, handler: Handler) => {
      electron.handlers.set(channel, handler);
    });
    window.isFocused.mockReturnValue(false);
    setPlatform('darwin');
    windows.open = [window];
    attention = registerAttention({
      openWindow,
      notifyScopePath: join(mkdtempSync(join(tmpdir(), 'attention-')), 'attention-preferences.json'),
    });
  });

  afterEach(() => setPlatform(originalPlatform));

  describe('attention notices', () => {
    it('shows a silent OS notification while no app window is focused', () => {
      call(IPC_CHANNELS.attentionNotify, notice);
      expect(electron.shown.map(shown => shown.options)).toEqual([
        { title: notice.title, body: notice.body, silent: true },
      ]);
    });

    it('shows nothing while the window is focused', () => {
      window.isFocused.mockReturnValue(true);
      call(IPC_CHANNELS.attentionNotify, notice);
      expect(electron.shown).toEqual([]);
    });

    it('refuses a malformed notice', () => {
      call(IPC_CHANNELS.attentionNotify, { ...notice, rootId: 42 });
      call(IPC_CHANNELS.attentionNotify, 'agent-1');
      expect(electron.shown).toEqual([]);
    });

    it('trims and caps the title and body before showing them', () => {
      call(IPC_CHANNELS.attentionNotify, { ...notice, title: `  ${'t'.repeat(500)}  `, body: `${'b'.repeat(900)}\n` });
      const { title, body } = electron.shown[0].options;
      expect(title).toBe('t'.repeat(120));
      expect(body).toBe('b'.repeat(240));
    });

    it('refuses a notice whose title is blank after trimming', () => {
      call(IPC_CHANNELS.attentionNotify, { ...notice, title: '   ' });
      expect(electron.shown).toEqual([]);
    });

    it('focuses the window and tells the renderer what to open when clicked', () => {
      window.isMinimized.mockReturnValue(true);
      call(IPC_CHANNELS.attentionNotify, notice);
      electron.shown[0].emit('click');
      expect(window.restore).toHaveBeenCalled();
      expect(window.show).toHaveBeenCalled();
      expect(window.focus).toHaveBeenCalled();
      expect(window.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.attentionOpen, {
        sessionId: 'agent-1',
        rootId: 'root-1',
      });
    });

    it('reopens a window when clicked with none open, and hands it the session once', () => {
      windows.open = [];
      call(IPC_CHANNELS.attentionNotify, notice);
      electron.shown[0].emit('click');
      expect(openWindow).toHaveBeenCalledTimes(1);
      expect(window.webContents.send).not.toHaveBeenCalled();
      expect(call(IPC_CHANNELS.attentionTakePendingOpen)).toEqual({ sessionId: 'agent-1', rootId: 'root-1' });
      expect(call(IPC_CHANNELS.attentionTakePendingOpen)).toBeNull();
    });

    it('has nothing pending when no notice reopened the window', () => {
      expect(call(IPC_CHANNELS.attentionTakePendingOpen)).toBeNull();
    });

    it('replaces an earlier notice for the same session rather than stacking them', () => {
      call(IPC_CHANNELS.attentionNotify, notice);
      call(IPC_CHANNELS.attentionNotify, { ...notice, body: 'second' });
      expect(electron.shown).toHaveLength(2);
      expect(electron.shown[0].close).toHaveBeenCalled();
      expect(electron.shown[1].close).not.toHaveBeenCalled();
    });
  });

  describe('claiming an entry across windows', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('lets only the first window announce a session that several windows saw enter needs-action', () => {
      expect(call(IPC_CHANNELS.attentionClaim, ['a', 'b'])).toEqual(['a', 'b']);
      expect(call(IPC_CHANNELS.attentionClaim, ['a', 'c'])).toEqual(['c']);
    });

    it('lets a later, separate entry of the same session through', () => {
      call(IPC_CHANNELS.attentionClaim, ['a']);
      vi.advanceTimersByTime(5000);
      expect(call(IPC_CHANNELS.attentionClaim, ['a'])).toEqual(['a']);
    });

    it('claims nothing for a malformed request', () => {
      expect(call(IPC_CHANNELS.attentionClaim, 'a')).toEqual([]);
      expect(call(IPC_CHANNELS.attentionClaim, ['a', 7, ''])).toEqual(['a']);
    });
  });

  describe('the notify scope setting', () => {
    it('starts at the default', async () => {
      expect(await call(IPC_CHANNELS.attentionGetNotifyScope)).toBe('agents');
    });

    it('saves a valid scope and pushes it to every window', async () => {
      const other = { webContents: { send: vi.fn() } };
      windows.open = [window, other];
      expect(await call(IPC_CHANNELS.attentionSetNotifyScope, 'all')).toBe('all');
      expect(await call(IPC_CHANNELS.attentionGetNotifyScope)).toBe('all');
      expect(window.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.attentionNotifyScope, 'all');
      expect(other.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.attentionNotifyScope, 'all');
    });

    it('refuses an unknown scope, keeping the current one without telling any window', async () => {
      expect(await call(IPC_CHANNELS.attentionSetNotifyScope, 'everything')).toBe('agents');
      expect(window.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('the dock badge', () => {
    it('shows the count on macOS and clears it at zero', () => {
      call(IPC_CHANNELS.attentionSetBadge, 3);
      call(IPC_CHANNELS.attentionSetBadge, 0);
      expect(electron.app.dock.setBadge.mock.calls).toEqual([['3'], ['']]);
    });

    it('ignores anything but a whole, non-negative count', () => {
      call(IPC_CHANNELS.attentionSetBadge, -1);
      call(IPC_CHANNELS.attentionSetBadge, 1.5);
      call(IPC_CHANNELS.attentionSetBadge, '2');
      expect(electron.app.dock.setBadge).not.toHaveBeenCalled();
    });

    it('clears once the last app window closes, not while another is open', () => {
      const closing = { once: vi.fn() };
      electron.appListeners.get('browser-window-created')?.({}, closing);
      const closed = closing.once.mock.calls[0][1] as () => void;
      closed();
      expect(electron.app.dock.setBadge).not.toHaveBeenCalled();

      window.isDestroyed.mockReturnValueOnce(true);
      closed();
      expect(electron.app.dock.setBadge).toHaveBeenCalledWith('');
    });

    it('sets the launcher count on Linux, clearing it at zero', () => {
      setPlatform('linux');
      call(IPC_CHANNELS.attentionSetBadge, 2);
      call(IPC_CHANNELS.attentionSetBadge, 0);
      expect(electron.app.setBadgeCount.mock.calls).toEqual([[2], [0]]);
      expect(electron.app.dock.setBadge).not.toHaveBeenCalled();
    });

    it('does nothing on Windows', () => {
      setPlatform('win32');
      call(IPC_CHANNELS.attentionSetBadge, 2);
      expect(electron.app.dock.setBadge).not.toHaveBeenCalled();
      expect(electron.app.setBadgeCount).not.toHaveBeenCalled();
    });
  });

  describe("main's needs-you watch", () => {
    const at = '2026-10-01T00:00:00.000Z';
    const sessions = [
      { id: 'root-1', title: 'Audit', createdAt: at, updatedAt: at, messageCount: 0, mode: 'code' },
      {
        id: 'agent-1',
        title: 'Review',
        createdAt: at,
        updatedAt: at,
        messageCount: 0,
        mode: 'code',
        origin: { parentSessionId: 'root-1', seedPrompt: 'review' },
      },
    ] as ChatSessionSummary[];
    const watch = () =>
      attention.watchNeedsYou({
        listSessions: async () => sessions,
        sessionMessages: async () => [],
      });

    it('hands back the same monitor when asked twice', () => {
      expect(watch()).toBe(watch());
    });

    it('announces an entry and keeps the badge with every window closed', async () => {
      windows.open = [];
      const monitor = watch();
      monitor.observe({ sessionId: 'agent-1', status: 'needs-action' });
      await monitor.settled();
      expect(electron.shown.map(shown => shown.options.title)).toEqual([expect.stringMatching(/ needs you$/)]);
      expect(electron.app.dock.setBadge).toHaveBeenLastCalledWith('1');
    });

    it('leaves the entry to the open window, so it is announced once', async () => {
      const monitor = watch();
      monitor.observe({ sessionId: 'agent-1', status: 'needs-action' });
      await monitor.settled();
      expect(electron.shown).toEqual([]);
      expect(electron.app.dock.setBadge).not.toHaveBeenCalled();
    });

    it('does not repeat an entry the closing window already claimed', async () => {
      const monitor = watch();
      expect(call(IPC_CHANNELS.attentionClaim, ['agent-1'])).toEqual(['agent-1']);
      windows.open = [];
      monitor.observe({ sessionId: 'agent-1', status: 'needs-action' });
      await monitor.settled();
      expect(electron.shown).toEqual([]);
      expect(electron.app.dock.setBadge).toHaveBeenLastCalledWith('1');
    });

    it('takes the badge over from the last window to close', async () => {
      const monitor = watch();
      monitor.observe({ sessionId: 'agent-1', status: 'needs-action' });
      const closing = { once: vi.fn() };
      electron.appListeners.get('browser-window-created')?.({}, closing);
      windows.open = [];
      (closing.once.mock.calls[0][1] as () => void)();
      await monitor.settled();
      expect(electron.app.dock.setBadge).toHaveBeenLastCalledWith('1');
      expect(electron.shown).toEqual([]);
    });
  });
});

describe('needsYouMonitor', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const session = (id: string, parentId?: string, extra: Partial<ChatSessionSummary> = {}): ChatSessionSummary =>
    ({
      id,
      title: `Session ${id}`,
      mode: 'code',
      messageCount: 0,
      createdAt: at,
      updatedAt: at,
      ...(parentId && { origin: { parentSessionId: parentId, seedPrompt: `seed ${id}` } }),
      ...extra,
    }) as ChatSessionSummary;

  const parked: ChatMessage[] = [
    {
      id: 'm1',
      role: 'assistant',
      content: '',
      createdAt: at,
      toolCalls: [
        { id: 'c1', name: 'bash', input: { command: 'pnpm test' }, status: 'awaiting-approval', approvalId: 'a1' },
      ],
    } as ChatMessage,
  ];

  let sessions: ChatSessionSummary[];
  let hasWindow: boolean;
  let scope: NotifyScope;
  let notices: AttentionNotice[];
  const setBadge = vi.fn<(count: number) => void>();
  const claim = vi.fn<(sessionIds: readonly string[]) => string[]>();
  let deps: NeedsYouMonitorDeps;
  let monitor: NeedsYouMonitor;

  beforeEach(() => {
    sessions = [session('root'), session('agent', 'root'), session('plain')];
    hasWindow = false;
    scope = 'agents';
    notices = [];
    setBadge.mockReset();
    claim.mockReset().mockImplementation(ids => [...ids]);
    deps = {
      listSessions: vi.fn(async () => sessions),
      sessionMessages: vi.fn(async () => parked),
      hasWindow: () => hasWindow,
      notifyScope: () => scope,
      claim,
      notify: notice => notices.push(notice),
      setBadge,
      warn: vi.fn(),
    };
    monitor = new NeedsYouMonitor(deps);
  });

  const enter = async (sessionId: string) => {
    monitor.observe({ sessionId, status: 'needs-action' });
    await monitor.settled();
  };

  describe('NeedsYouMonitor with no window open', () => {
    it('announces an agent entering needs-action, named and described as the renderer would', async () => {
      await enter('agent');
      expect(notices).toEqual([
        { sessionId: 'agent', rootId: 'root', title: expect.stringMatching(/ needs you$/), body: 'bash pnpm test' },
      ]);
      expect(notices[0]?.title).not.toContain('Session agent');
      expect(setBadge).toHaveBeenLastCalledWith(1);
    });

    it('counts completed task attention only when the session status needs action', async () => {
      sessions = [
        session('root'),
        session('agent', 'root', {
          workerTask: { state: { status: 'completed', accepted: false } },
        } as Partial<ChatSessionSummary>),
      ];
      monitor.observe({ sessionId: 'agent', status: 'processing' });
      monitor.observe({ sessionId: 'agent', status: 'done' });
      await monitor.settled();
      expect(setBadge).toHaveBeenLastCalledWith(0);
      expect(notices).toEqual([]);
      monitor.observe({ sessionId: 'agent', status: 'needs-action', unreadReply: true });
      await monitor.settled();
      expect(setBadge).toHaveBeenLastCalledWith(1);
      monitor.observe({ sessionId: 'agent', status: 'done' });
      await monitor.settled();
      expect(setBadge).toHaveBeenLastCalledWith(0);
    });

    it('announces once per entry, and again after the session left needs-action', async () => {
      await enter('agent');
      await enter('agent');
      expect(notices).toHaveLength(1);
      monitor.observe({ sessionId: 'agent', status: 'processing' });
      await enter('agent');
      expect(notices).toHaveLength(2);
    });

    it('badges an unread finished reply without a notice, and still announces a request that lands on it', async () => {
      monitor.observe({ sessionId: 'agent', status: 'needs-action', unreadReply: true });
      await monitor.settled();
      expect(notices).toEqual([]);
      expect(setBadge).toHaveBeenLastCalledWith(1);
      await enter('agent');
      expect(notices).toHaveLength(1);
    });

    it('names the parent by its title when the parent is the one waiting', async () => {
      await enter('root');
      expect(notices[0]).toMatchObject({ sessionId: 'root', rootId: 'root', title: 'Session root needs you' });
    });

    it('stays quiet for plain, archived and deleted sessions; only the plain one counts on the badge', async () => {
      sessions = [...sessions, session('shelved', undefined, { archived: true }), session('under', 'shelved')];
      await enter('plain');
      await enter('under');
      await enter('gone');
      expect(notices).toEqual([]);
      expect(setBadge).toHaveBeenLastCalledWith(1);
    });

    it('with the all scope, announces and counts a plain session, but not an archived one', async () => {
      scope = 'all';
      sessions = [...sessions, session('shelved', undefined, { archived: true })];
      await enter('plain');
      await enter('shelved');
      expect(notices).toEqual([
        { sessionId: 'plain', rootId: 'plain', title: 'Session plain needs you', body: 'bash pnpm test' },
      ]);
      expect(setBadge).toHaveBeenLastCalledWith(1);
    });

    it('skips an entry another announcer already claimed, but still counts it', async () => {
      claim.mockReturnValue([]);
      await enter('agent');
      expect(notices).toEqual([]);
      expect(setBadge).toHaveBeenLastCalledWith(1);
    });

    it('still announces, with the fallback body, when the session cannot be read', async () => {
      deps.sessionMessages = vi.fn(async () => {
        throw new Error('gone');
      });
      await enter('agent');
      expect(notices[0]?.body).toBe('Waiting for your answer');
    });

    it('drops an entry the session already left while the list was being read', async () => {
      monitor.observe({ sessionId: 'agent', status: 'needs-action' });
      monitor.observe({ sessionId: 'agent', status: 'processing' });
      await monitor.settled();
      expect(notices).toEqual([]);
      expect(setBadge).toHaveBeenLastCalledWith(0);
    });

    it("clears the badge on sign-out, once the old account's sessions are no longer listed", async () => {
      await enter('agent');
      expect(setBadge).toHaveBeenLastCalledWith(1);
      sessions = [];
      monitor.scopeChanged();
      await monitor.settled();
      expect(setBadge).toHaveBeenLastCalledWith(0);
    });

    it('recounts the badge when the last window closes, without announcing what was already waiting', async () => {
      hasWindow = true;
      monitor.observe({ sessionId: 'agent', status: 'needs-action' });
      hasWindow = false;
      monitor.windowsClosed();
      await monitor.settled();
      expect(setBadge).toHaveBeenLastCalledWith(1);
      expect(notices).toEqual([]);
    });

    it('recounts the badge on a status change that neither enters nor leaves needs-action, without a notice', async () => {
      monitor.observe({ sessionId: 'agent', status: 'processing' });
      monitor.observe({ sessionId: 'agent', status: 'done' });
      await monitor.settled();
      expect(deps.listSessions).toHaveBeenCalled();
      expect(setBadge).toHaveBeenLastCalledWith(0);
      expect(notices).toEqual([]);
    });

    it('recounts when a session enters needs-action and again when it leaves', async () => {
      await enter('agent');
      expect(setBadge).toHaveBeenCalledTimes(1);
      expect(setBadge).toHaveBeenLastCalledWith(1);
      sessions = [session('root'), session('plain')];
      monitor.observe({ sessionId: 'agent', status: 'done' });
      await monitor.settled();
      expect(setBadge).toHaveBeenCalledTimes(2);
      expect(setBadge).toHaveBeenLastCalledWith(0);
    });

    it('keeps working after an update fails', async () => {
      deps.listSessions = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(sessions);
      await enter('agent');
      expect(deps.warn).toHaveBeenCalled();
      monitor.observe({ sessionId: 'agent', status: 'processing' });
      await enter('agent');
      expect(notices).toHaveLength(1);
    });
  });

  describe('NeedsYouMonitor with a window open', () => {
    beforeEach(() => {
      hasWindow = true;
    });

    it('leaves announcing and the badge to the renderer', async () => {
      await enter('agent');
      expect(notices).toEqual([]);
      expect(setBadge).not.toHaveBeenCalled();
      expect(deps.listSessions).not.toHaveBeenCalled();
    });

    it('leaves the badge alone on sign-out; the remounting chat recounts it', async () => {
      monitor.scopeChanged();
      await monitor.settled();
      expect(setBadge).not.toHaveBeenCalled();
    });

    it('stands down when a window opens while the list is being read', async () => {
      hasWindow = false;
      deps.listSessions = vi.fn(async () => {
        hasWindow = true;
        return sessions;
      });
      await enter('agent');
      expect(notices).toEqual([]);
      expect(setBadge).not.toHaveBeenCalled();
    });
  });
});

describe('NotifyScopeStore', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'notify-scope-'));
    filePath = join(directory, 'attention-preferences.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  describe('NotifyScopeStore', () => {
    it('defaults to agents only when nothing is stored', async () => {
      expect(await new NotifyScopeStore(filePath).load()).toBe('agents');
    });

    it('falls back to the default for an unreadable or unknown value', async () => {
      await writeFile(filePath, '{"notifyScope":"everything"}');
      expect(await new NotifyScopeStore(filePath).load()).toBe('agents');
      await writeFile(filePath, 'not json');
      expect(await new NotifyScopeStore(filePath).load()).toBe('agents');
    });

    it('keeps a saved scope across a reload', async () => {
      const store = new NotifyScopeStore(filePath);
      await store.load();
      expect(await store.set('all')).toBe('all');
      expect(store.current()).toBe('all');
      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ notifyScope: 'all' });
      expect(await new NotifyScopeStore(filePath).load()).toBe('all');
    });
  });
});

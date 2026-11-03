import { IPC_CHANNELS } from '@shared/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    app: { dock: { setBadge: vi.fn() } },
    ipcMain: { handle: vi.fn() },
  };
});

const window = vi.hoisted(() => ({
  isFocused: vi.fn(() => false),
  isMinimized: vi.fn(() => false),
  restore: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  webContents: { send: vi.fn() },
}));

vi.mock('electron', () => electron);
vi.mock('../windows', () => ({ appWindows: () => [window] }));

const { registerAttention } = await import('./index');

const notice = { sessionId: 'agent-1', rootId: 'root-1', title: 'Brannoc the Warden needs you', body: 'bash rm -rf' };
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
  registerAttention();
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

  it('does nothing off macOS', () => {
    setPlatform('linux');
    call(IPC_CHANNELS.attentionSetBadge, 2);
    expect(electron.app.dock.setBadge).not.toHaveBeenCalled();
  });
});

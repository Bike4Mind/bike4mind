import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WATCH_PREFERENCES, EMPTY_WATCH_SNAPSHOT, type WatchSnapshot } from '@shared/watch';

const electron = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => electron.handlers.set(channel, handler),
  },
}));

const { IPC_CHANNELS } = await import('@shared/ipc');
const { registerWatchIpc } = await import('./ipc');

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

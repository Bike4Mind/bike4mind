import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTimeout as settlePromises } from 'node:timers/promises';
import type { EventEmitter } from 'node:events';
import type { ChatSessionStatusEvent } from '@shared/chat';
import type { UpdateDeps } from './update';

const harness = vi.hoisted(() => {
  const shutdown = () => vi.fn(async (): Promise<void> => undefined);
  return {
    background: { shutdown: shutdown(), shutdownSync: vi.fn(), runningCount: vi.fn(() => 0) },
    mcp: { shutdown: shutdown(), shutdownSync: vi.fn() },
    terminals: { shutdown: shutdown(), shutdownSync: vi.fn(), runningCount: vi.fn(() => 0) },
    models: { runningCount: vi.fn(() => 0) },
    modelServers: { runningLocalServerCount: vi.fn(() => 0) },
    sessionStatuses: vi.fn<() => ChatSessionStatusEvent[]>(() => []),
    registerUpdates: vi.fn<(deps: UpdateDeps) => void>(),
    showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
    cookies: { clearOnQuit: shutdown() },
    spareWorktrees: { dispose: shutdown() },
    stopLocalServers: shutdown(),
    quit: vi.fn(),
    windows: [] as EventEmitter[],
  };
});

vi.mock('./bootstrapIdentity', () => ({}));
vi.mock('../../build/icon.png?asset', () => ({ default: '' }));
vi.mock('../../build/icon-mac.png?asset', () => ({ default: '' }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    app: Object.assign(new EventEmitter(), {
      whenReady: async () => undefined,
      getPath: () => '/unused',
      isPackaged: true,
      quit: harness.quit,
    }),
    BrowserWindow: class extends EventEmitter {
      constructor() {
        super();
        harness.windows.push(this);
      }
      webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() };
      loadFile = vi.fn();
    },
    ipcMain: { handle: vi.fn() },
    shell: {},
    dialog: { showMessageBox: harness.showMessageBox },
  };
});
vi.mock('./account', () => ({ registerAccount: vi.fn() }));
vi.mock('./auth', () => ({
  registerAuth: () => ({ getState: () => ({}), initialize: vi.fn() }),
  onAuthStateChanged: vi.fn(),
}));
vi.mock('./attention', () => ({
  registerAttention: () => ({ watchNeedsYou: () => ({}) }),
}));
vi.mock('./usage', () => ({ registerUsage: vi.fn() }));
vi.mock('./fleet', () => ({
  registerFleet: () => ({ setDirectoryResolver: vi.fn(), setModelResolver: vi.fn() }),
}));
vi.mock('./loops', () => ({
  registerLoopRunner: () => ({
    runner: {
      observe: vi.fn(),
      unattended: vi.fn(),
      merge: vi.fn(),
      releaseAll: vi.fn(async () => undefined),
      dispose: vi.fn(),
    },
    sync: vi.fn(async () => undefined),
  }),
}));
vi.mock('./models', () => ({ registerModels: () => harness.models }));
vi.mock('./terminal', () => ({ registerTerminals: () => harness.terminals }));
vi.mock('./update', () => ({ registerUpdates: harness.registerUpdates }));
vi.mock('./devlog', () => ({
  registerDevLog: vi.fn(),
  attachDevLogShortcut: vi.fn(),
  closeDevLogWindow: vi.fn(),
}));
vi.mock('./logFile', () => ({ persistConsoleWarnings: vi.fn() }));
vi.mock('./windows', () => ({ appWindows: () => harness.windows }));
vi.mock('./chat/sessionScope', () => ({ sessionScopeFor: () => null, sessionScopeForChat: () => null }));
vi.mock('./chat/browser/browserScope', () => ({ closeBrowsersOnScopeChange: vi.fn() }));
vi.mock('./chat/tools/userPath', () => ({ resolveUserPath: vi.fn() }));
vi.mock('./chat/artifacts/sandboxProtocol', () => ({ registerArtifactScheme: vi.fn() }));
vi.mock('./chat/model3d/engineProtocol', () => ({ registerModelScheme: vi.fn() }));
vi.mock('./chat/media/protocol', () => ({ registerMediaScheme: vi.fn() }));
vi.mock('./chat', () => ({
  registerChat: () => ({
    service: { sessionStatuses: harness.sessionStatuses },
    background: harness.background,
    mcp: harness.mcp,
    modelServers: harness.modelServers,
    browser: { cookies: harness.cookies },
    spareWorktrees: harness.spareWorktrees,
    stopLocalServers: harness.stopLocalServers,
    claudeImport: { start: vi.fn() },
  }),
}));

import { app } from 'electron';

const cleanupTasks = [
  harness.background.shutdown,
  harness.mcp.shutdown,
  harness.terminals.shutdown,
  harness.cookies.clearOnQuit,
  harness.spareWorktrees.dispose,
  harness.stopLocalServers,
];
const originalPlatform = process.platform;

describe('application quit', () => {
  beforeEach(async () => {
    vi.resetModules();
    harness.quit.mockReset();
    harness.windows.length = 0;
    harness.sessionStatuses.mockReset().mockReturnValue([]);
    harness.registerUpdates.mockReset();
    harness.showMessageBox.mockReset().mockResolvedValue({ response: 0, checkboxChecked: false });
    harness.background.runningCount.mockReset().mockReturnValue(0);
    harness.terminals.runningCount.mockReset().mockReturnValue(0);
    harness.models.runningCount.mockReset().mockReturnValue(0);
    harness.modelServers.runningLocalServerCount.mockReset().mockReturnValue(0);
    for (const task of cleanupTasks) task.mockReset().mockResolvedValue(undefined);
    app.removeAllListeners();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.spyOn(process, 'on').mockReturnValue(process);
    vi.useFakeTimers({ toFake: ['setImmediate'] });
    await import('./index');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    app.removeAllListeners();
  });

  function requestQuit() {
    const event = { preventDefault: vi.fn() };
    app.emit('before-quit', event);
    return event;
  }

  it('resumes a single quit on a new event-loop turn after cleanup', async () => {
    const cleanup = Promise.withResolvers<void>();
    harness.mcp.shutdown.mockReturnValue(cleanup.promise);
    const event = requestQuit();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(harness.showMessageBox).not.toHaveBeenCalled();
    for (const task of cleanupTasks) expect(task).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect(harness.quit).not.toHaveBeenCalled();

    cleanup.resolve();
    await settlePromises(0);
    expect(harness.quit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await vi.runAllTimersAsync();
    expect(harness.quit).toHaveBeenCalledOnce();
    expect(requestQuit().preventDefault).not.toHaveBeenCalled();
    for (const task of cleanupTasks) expect(task).toHaveBeenCalledOnce();
  });

  it('still defers the resumed quit if cleanup fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    harness.mcp.shutdown.mockRejectedValue(new Error('Connection already closed'));
    requestQuit();
    await settlePromises(0);
    expect(harness.quit).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(harness.quit).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith('QUIT: cleanup failed', expect.any(Error));
  });

  const busyCases = [
    {
      name: 'active agents',
      setup: () => harness.sessionStatuses.mockReturnValue([{ sessionId: 'agent', status: 'processing' }]),
      detail: '1 session is still working.',
    },
    {
      name: 'pending approvals',
      setup: () => harness.sessionStatuses.mockReturnValue([{ sessionId: 'agent', status: 'needs-action' }]),
      detail: '1 session is waiting for you.',
    },
    {
      name: 'background commands',
      setup: () => harness.background.runningCount.mockReturnValue(2),
      detail: '2 background processes are running.',
    },
    {
      name: 'terminals',
      setup: () => harness.terminals.runningCount.mockReturnValue(1),
      detail: '1 terminal session is open.',
    },
    {
      name: 'model downloads',
      setup: () => harness.models.runningCount.mockReturnValue(1),
      detail: '1 model download is active.',
    },
    {
      name: 'Desktop model servers',
      setup: () => harness.modelServers.runningLocalServerCount.mockReturnValue(1),
      detail: '1 model server is running.',
    },
  ];

  it.each(busyCases)('keeps $name running when the user cancels', async ({ setup, detail }) => {
    setup();
    expect(requestQuit().preventDefault).toHaveBeenCalledOnce();
    await settlePromises(0);
    await vi.runAllTimersAsync();

    expect(harness.showMessageBox).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        detail: expect.stringContaining(detail),
        buttons: ['Keep Running', 'Quit Anyway'],
        defaultId: 0,
        cancelId: 0,
      })
    );
    for (const task of cleanupTasks) expect(task).not.toHaveBeenCalled();
    expect(harness.quit).not.toHaveBeenCalled();

    requestQuit();
    expect(harness.showMessageBox).toHaveBeenCalledTimes(2);
    await settlePromises(0);
  });

  it('does not let repeated quit requests bypass an open confirmation or pending cleanup', async () => {
    harness.background.runningCount.mockReturnValue(1);
    const confirmation = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>();
    harness.showMessageBox.mockReturnValue(confirmation.promise);
    const cleanup = Promise.withResolvers<void>();
    harness.mcp.shutdown.mockReturnValue(cleanup.promise);

    requestQuit();
    expect(requestQuit().preventDefault).toHaveBeenCalledOnce();
    expect(harness.showMessageBox).toHaveBeenCalledOnce();
    for (const task of cleanupTasks) expect(task).not.toHaveBeenCalled();

    confirmation.resolve({ response: 1, checkboxChecked: false });
    await settlePromises(0);
    expect(requestQuit().preventDefault).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect(harness.quit).not.toHaveBeenCalled();
    for (const task of cleanupTasks) expect(task).toHaveBeenCalledOnce();

    cleanup.resolve();
    await settlePromises(0);
    expect(harness.quit).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(harness.quit).toHaveBeenCalledOnce();
    expect(requestQuit().preventDefault).not.toHaveBeenCalled();
    expect(harness.showMessageBox).toHaveBeenCalledOnce();
  });

  it('keeps work running and allows another request if the dialog fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    harness.background.runningCount.mockReturnValue(1);
    harness.showMessageBox.mockRejectedValueOnce(new Error('Dialog unavailable'));
    requestQuit();
    await settlePromises(0);
    for (const task of cleanupTasks) expect(task).not.toHaveBeenCalled();
    expect(harness.quit).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith('QUIT: could not prepare to quit', expect.any(Error));
    requestQuit();
    expect(harness.showMessageBox).toHaveBeenCalledTimes(2);
    await settlePromises(0);
  });

  it('reuses the same activity report for updates and bypasses a second prompt after updater cleanup', async () => {
    harness.sessionStatuses.mockReturnValue([{ sessionId: 'agent', status: 'processing' }]);
    harness.background.runningCount.mockReturnValue(2);
    harness.terminals.runningCount.mockReturnValue(3);
    harness.models.runningCount.mockReturnValue(4);
    harness.modelServers.runningLocalServerCount.mockReturnValue(5);
    const deps = harness.registerUpdates.mock.calls[0][0];
    expect(deps.busy()).toEqual({
      replying: 1,
      awaitingApproval: 0,
      background: 2,
      terminals: 3,
      modelDownloads: 4,
      modelServers: 5,
    });
    await deps.prepareQuit();
    expect(requestQuit().preventDefault).not.toHaveBeenCalled();
    expect(harness.showMessageBox).not.toHaveBeenCalled();
    for (const task of cleanupTasks) expect(task).toHaveBeenCalledOnce();
  });

  it('does not block process termination on a pending confirmation', async () => {
    harness.background.runningCount.mockReturnValue(1);
    const confirmation = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>();
    harness.showMessageBox.mockReturnValue(confirmation.promise);
    requestQuit();
    harness.quit.mockImplementation(() => {
      requestQuit();
    });
    const terminate = vi.mocked(process.on).mock.calls.find(([signal]) => signal === 'SIGTERM')?.[1];
    expect(terminate).toBeDefined();
    terminate?.();
    await settlePromises(0);
    await vi.runAllTimersAsync();
    for (const task of cleanupTasks) expect(task).toHaveBeenCalledOnce();
    confirmation.resolve({ response: 0, checkboxChecked: false });
    await settlePromises(0);
    expect(requestQuit().preventDefault).not.toHaveBeenCalled();
    expect(harness.showMessageBox).toHaveBeenCalledOnce();
  });

  it('waits for the rest of cleanup even if one cleanup task fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    harness.mcp.shutdown.mockRejectedValue(new Error('Already closed'));
    const cleanup = Promise.withResolvers<void>();
    harness.terminals.shutdown.mockReturnValue(cleanup.promise);
    requestQuit();
    await settlePromises(0);
    await vi.runAllTimersAsync();
    expect(harness.quit).not.toHaveBeenCalled();
    cleanup.resolve();
    await settlePromises(0);
    await vi.runAllTimersAsync();
    expect(harness.quit).toHaveBeenCalledOnce();
  });

  it('keeps the last window open on Windows or Linux if the user cancels quitting', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    harness.background.runningCount.mockReturnValue(1);
    harness.quit.mockImplementation(() => {
      requestQuit();
    });
    const event = { preventDefault: vi.fn() };
    harness.windows[0].emit('close', event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(harness.showMessageBox).toHaveBeenCalledOnce();
    await settlePromises(0);
    for (const task of cleanupTasks) expect(task).not.toHaveBeenCalled();

    harness.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    harness.windows[0].emit('close', { preventDefault: vi.fn() });
    await settlePromises(0);
    await vi.runAllTimersAsync();
    const approved = { preventDefault: vi.fn() };
    harness.windows[0].emit('close', approved);
    expect(approved.preventDefault).not.toHaveBeenCalled();
  });

  it('still closes a macOS window without quitting or prompting', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    harness.background.runningCount.mockReturnValue(1);
    const event = { preventDefault: vi.fn() };
    harness.windows[0].emit('close', event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(harness.quit).not.toHaveBeenCalled();
    expect(harness.showMessageBox).not.toHaveBeenCalled();
  });

  it('does not let a failed stale dialog undo updater cleanup', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    harness.background.runningCount.mockReturnValue(1);
    const confirmation = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>();
    harness.showMessageBox.mockReturnValue(confirmation.promise);
    requestQuit();
    await harness.registerUpdates.mock.calls[0][0].prepareQuit();
    confirmation.reject(new Error('Dialog closed during install'));
    await settlePromises(0);
    expect(requestQuit().preventDefault).not.toHaveBeenCalled();
    for (const task of cleanupTasks) expect(task).toHaveBeenCalledOnce();
  });
});

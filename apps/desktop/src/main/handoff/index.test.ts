import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AuthService } from '../auth';

type WindowFixture = {
  close(): void;
  crash(): void;
  isDestroyed(): boolean;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  webContents: { on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> };
};
const h = vi.hoisted(() => ({
  handler: null as null | (() => Promise<void>),
  listener: null as null | (() => void),
  options: [] as Record<string, unknown>[],
  windows: [] as WindowFixture[],
  loadURL: vi.fn(),
  close: vi.fn(),
  clearStorageData: vi.fn<(partition: string) => Promise<void>>(),
  fromPartition: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: () => Promise<void>) => {
      if (channel === 'handoff:open-server-sessions') h.handler = handler;
    },
  },
  shell: { openExternal: vi.fn() },
  session: { fromPartition: h.fromPartition },
  BrowserWindow: class {
    private closed: (() => void) | null = null;
    private destroyed = false;
    constructor(options: Record<string, unknown>) {
      h.options.push(options);
      h.windows.push(this);
    }
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn(), off: vi.fn(), getUserAgent: () => 'Electron' };
    on(event: string, callback: () => void) {
      if (event === 'closed') this.closed = callback;
    }
    loadURL = h.loadURL;
    show = vi.fn();
    focus = vi.fn();
    isDestroyed = () => this.destroyed;
    close() {
      h.close();
      this.destroyed = true;
      this.closed?.();
    }
    /** Destroyed without the `closed` event having run yet, so the companion slot still points here. */
    crash() {
      this.destroyed = true;
    }
  },
}));
vi.mock('../auth', () => ({
  onAuthStateChanged: (listener: () => void) => {
    h.listener = listener;
  },
}));
vi.mock('../windows', () => ({ markCompanionWindow: vi.fn() }));
import { registerSessionHandoff } from './index';

const initialState = () => ({
  status: 'signed-in',
  environment: { url: 'https://app.example.test' },
  user: { id: 'user' },
});
type ApiFixture = { post: ReturnType<typeof vi.fn> } | null;
/** An AuthService fixture; with no API client the window falls back to the plain web sign-in. */
const authFor = (state: unknown, api: ApiFixture = null) =>
  ({ getState: () => state, getSessionBoundApiClient: () => api }) as unknown as AuthService;
const partitionAt = (index: number) => (h.options[index].webPreferences as { partition: string }).partition;
const expectedPartition = (scope: string) =>
  `persist:server-conversations-${createHash('sha256').update(scope).digest('hex')}`;
const open = async () => {
  if (!h.handler) throw new Error('Handoff IPC was not registered');
  await h.handler();
};
const changed = () => {
  if (!h.listener) throw new Error('Auth listener was not registered');
  h.listener();
};
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('desktop server conversations handoff surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.handler = null;
    h.listener = null;
    h.options.length = 0;
    h.windows.length = 0;
    h.clearStorageData.mockReset().mockResolvedValue(undefined);
    h.loadURL.mockReset().mockResolvedValue(undefined);
    h.fromPartition.mockImplementation((partition: string) => ({
      clearStorageData: () => h.clearStorageData(partition),
    }));
  });

  it('uses a sandbox without a privileged preload and clears the captured owner on synchronous close', async () => {
    const state = initialState();
    registerSessionHandoff(authFor(state));
    expect(IPC_CHANNELS.handoffOpenServerSessions).toBe('handoff:open-server-sessions');
    await open();
    expect(h.options[0].webPreferences).toEqual({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: expect.stringMatching(/^persist:server-conversations-[a-f0-9]{64}$/),
    });
    expect(h.loadURL).toHaveBeenCalledWith('https://app.example.test/notebooks', {
      userAgent: 'Electron B4M-Server-Conversations',
    });
    const owner = partitionAt(0);
    state.status = 'signed-out';
    changed();
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.fromPartition).toHaveBeenCalledExactlyOnceWith(owner);
    expect(h.clearStorageData).toHaveBeenCalledExactlyOnceWith(owner);
  });

  it.each(['sign-out', 'user', 'environment'] as const)(
    'clears ownership after an ordinary close and %s change',
    async change => {
      const state = initialState();
      registerSessionHandoff(authFor(state));
      await open();
      const owner = partitionAt(0);
      h.windows[0].close();
      if (change === 'sign-out') state.status = 'signed-out';
      else if (change === 'user') state.user.id = 'another-user';
      else state.environment.url = 'https://other.example.test';
      changed();
      expect(h.fromPartition).toHaveBeenCalledExactlyOnceWith(owner);
      expect(h.clearStorageData).toHaveBeenCalledExactlyOnceWith(owner);
    }
  );

  it('reopens a normally closed window in the same partition without clearing it', async () => {
    const state = initialState();
    registerSessionHandoff(authFor(state));
    await open();
    h.windows[0].close();
    await open();
    expect(h.options).toHaveLength(2);
    expect(partitionAt(1)).toBe(partitionAt(0));
    expect(h.clearStorageData).not.toHaveBeenCalled();
  });

  it('observes initialized auth ownership without opening a window', async () => {
    const state = initialState();
    state.status = 'signed-out';
    registerSessionHandoff(authFor(state));
    state.status = 'signed-in';
    changed();
    state.status = 'signed-out';
    changed();
    expect(h.options).toHaveLength(0);
    expect(h.clearStorageData).toHaveBeenCalledExactlyOnceWith(expectedPartition('https://app.example.test:user'));
  });

  it('waits for its own cleanup and creates only one window for concurrent opens', async () => {
    const state = initialState();
    registerSessionHandoff(authFor(state));
    await open();
    const pending = deferred();
    h.clearStorageData.mockReturnValueOnce(pending.promise);
    state.status = 'signed-out';
    changed();
    state.status = 'signed-in';
    changed();
    const first = open();
    const second = open();
    expect(h.loadURL).toHaveBeenCalledTimes(1);
    pending.resolve();
    await Promise.all([first, second]);
    expect(h.loadURL).toHaveBeenCalledTimes(2);
    expect(h.options).toHaveLength(2);
    expect(h.windows[1].show).toHaveBeenCalledOnce();
  });

  it('invalidates an old open across sign-out and return to the same owner', async () => {
    const state = initialState();
    registerSessionHandoff(authFor(state));
    await open();
    const pending = deferred();
    h.clearStorageData.mockReturnValueOnce(pending.promise);
    state.status = 'signed-out';
    changed();
    state.status = 'signed-in';
    changed();
    const stale = open();
    state.status = 'signed-out';
    changed();
    state.status = 'signed-in';
    changed();
    pending.resolve();
    await stale;
    expect(h.loadURL).toHaveBeenCalledTimes(1);
    await open();
    expect(h.loadURL).toHaveBeenCalledTimes(2);
  });

  it('does not make a different account wait for the old partition cleanup', async () => {
    const state = initialState();
    registerSessionHandoff(authFor(state));
    await open();
    const owner = partitionAt(0);
    const pending = deferred();
    h.clearStorageData.mockReturnValueOnce(pending.promise);
    state.user.id = 'another-user';
    changed();
    await open();
    expect(h.loadURL).toHaveBeenCalledTimes(2);
    expect(partitionAt(1)).not.toBe(owner);
    expect(h.clearStorageData).toHaveBeenCalledExactlyOnceWith(owner);
    pending.resolve();
    await pending.promise;
  });

  it('retains failed cleanup for retry and never loads the dirty partition', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const state = initialState();
      registerSessionHandoff(authFor(state));
      await open();
      const owner = partitionAt(0);
      const pending = deferred();
      h.clearStorageData.mockReturnValueOnce(pending.promise);
      state.status = 'signed-out';
      changed();
      state.status = 'signed-in';
      changed();
      const blocked = open();
      expect(h.clearStorageData).toHaveBeenCalledWith(owner);
      pending.reject(new Error('cleanup unavailable'));
      await blocked;
      expect(h.loadURL).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        'handoff: could not clear server conversations storage',
        'cleanup unavailable'
      );
      await open();
      expect(h.clearStorageData).toHaveBeenNthCalledWith(2, owner);
      expect(h.loadURL).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
    }
  });

  it('does not open for a signed-out account', async () => {
    registerSessionHandoff(authFor({ status: 'signed-out' }));
    await open();
    expect(h.options).toEqual([]);
  });

  describe('signing the window in from the Desktop session', () => {
    it('redeems a minted code with a POST navigation, keeping the code out of the URL', async () => {
      const api = { post: vi.fn().mockResolvedValue({ code: 'one-time-code', expiresInSeconds: 60 }) };
      registerSessionHandoff(authFor(initialState(), api));
      await open();

      expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/auth/desktop-web-session');
      expect(h.loadURL).toHaveBeenCalledExactlyOnceWith(
        'https://app.example.test/api/auth/desktop-web-session/redeem',
        {
          userAgent: 'Electron B4M-Server-Conversations',
          postData: [{ type: 'rawData', bytes: Buffer.from(JSON.stringify({ code: 'one-time-code' })) }],
          extraHeaders: 'Content-Type: application/json',
        }
      );
    });

    it.each([
      ['answers with a server error', 500, true],
      ['lands on notebooks', 200, false],
    ])('falls back to the plain web sign-in only when the redeem page %s', async (_label, status, fallsBack) => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const api = { post: vi.fn().mockResolvedValue({ code: 'one-time-code' }) };
        h.loadURL.mockImplementationOnce(async (url: string) => {
          const [, onNavigate] = h.windows[0].webContents.on.mock.calls.find(([event]) => event === 'did-navigate')!;
          const landed = status < 400 ? 'https://app.example.test/notebooks' : url;
          onNavigate({}, landed, status);
        });
        registerSessionHandoff(authFor(initialState(), api));
        await open();

        expect(h.windows[0].webContents.off).toHaveBeenCalledWith('did-navigate', expect.any(Function));
        expect(h.loadURL).toHaveBeenCalledTimes(fallsBack ? 2 : 1);
        if (fallsBack) {
          expect(h.loadURL).toHaveBeenLastCalledWith('https://app.example.test/notebooks', {
            userAgent: 'Electron B4M-Server-Conversations',
          });
        }
      } finally {
        warning.mockRestore();
      }
    });

    it.each([
      ['the mint request fails', vi.fn().mockRejectedValue(new Error('403'))],
      ['the response has no code', vi.fn().mockResolvedValue({})],
    ])('falls back to the plain web sign-in when %s', async (_label, post) => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        registerSessionHandoff(authFor(initialState(), { post }));
        await open();
        expect(h.loadURL).toHaveBeenCalledExactlyOnceWith('https://app.example.test/notebooks', {
          userAgent: 'Electron B4M-Server-Conversations',
        });
      } finally {
        warning.mockRestore();
      }
    });

    it('loads nothing when the account changes while the code is being minted', async () => {
      const state = initialState();
      const minted = deferred();
      const api = { post: vi.fn(() => minted.promise.then(() => ({ code: 'one-time-code' }))) };
      registerSessionHandoff(authFor(state, api));
      const opening = open();
      await vi.waitFor(() => expect(api.post).toHaveBeenCalled());

      state.user.id = 'another-user';
      changed();
      minted.resolve();
      await opening;

      expect(h.close).toHaveBeenCalledOnce();
      expect(h.loadURL).not.toHaveBeenCalled();
    });

    it('loads nothing when the window is destroyed while the code is being minted', async () => {
      const minted = deferred();
      const api = { post: vi.fn(() => minted.promise.then(() => ({ code: 'one-time-code' }))) };
      registerSessionHandoff(authFor(initialState(), api));
      const opening = open();
      await vi.waitFor(() => expect(api.post).toHaveBeenCalled());

      h.windows[0].crash();
      minted.resolve();
      await opening;

      expect(h.loadURL).not.toHaveBeenCalled();
    });

    it('loads only the replacement window when the window is closed and reopened mid-mint', async () => {
      const firstMint = deferred();
      const secondMint = deferred();
      const api = {
        post: vi
          .fn()
          .mockImplementationOnce(() => firstMint.promise.then(() => ({ code: 'stale-code' })))
          .mockImplementationOnce(() => secondMint.promise.then(() => ({ code: 'fresh-code' }))),
      };
      registerSessionHandoff(authFor(initialState(), api));
      const firstOpening = open();
      await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));

      h.windows[0].close();
      const secondOpening = open();
      await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
      firstMint.resolve();
      await firstOpening;
      expect(h.loadURL).not.toHaveBeenCalled();

      secondMint.resolve();
      await secondOpening;
      expect(h.windows).toHaveLength(2);
      expect(h.loadURL).toHaveBeenCalledOnce();
      expect(h.loadURL.mock.calls[0][1].postData[0].bytes.toString()).toContain('fresh-code');
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AuthService } from '../auth';

const h = vi.hoisted(() => ({
  handler: null as null | (() => Promise<void>),
  listener: null as null | (() => void),
  options: [] as Record<string, unknown>[],
  loadURL: vi.fn(),
  close: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: () => Promise<void>) => {
      if (channel === 'handoff:open-server-sessions') h.handler = handler;
    },
  },
  shell: { openExternal: vi.fn() },
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) {
      h.options.push(options);
    }
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn(), getUserAgent: () => 'Electron' };
    on = vi.fn();
    loadURL = h.loadURL;
    close = h.close;
  },
}));
vi.mock('../auth', () => ({
  onAuthStateChanged: (listener: () => void) => {
    h.listener = listener;
  },
}));
vi.mock('../windows', () => ({ markCompanionWindow: vi.fn() }));
import { registerSessionHandoff } from './index';

describe('desktop server conversations handoff surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.options.length = 0;
  });
  it('uses a sandbox without a privileged preload, a scoped cookie partition, and normal web sign-in', async () => {
    const state = { status: 'signed-in', environment: { url: 'https://app.example.test' }, user: { id: 'user' } };
    registerSessionHandoff({ getState: () => state } as unknown as AuthService);
    expect(IPC_CHANNELS.handoffOpenServerSessions).toBe('handoff:open-server-sessions');
    await h.handler?.();
    expect(h.options[0].webPreferences).toEqual({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: expect.stringMatching(/^persist:server-conversations-[a-f0-9]{64}$/),
    });
    expect(h.loadURL).toHaveBeenCalledWith('https://app.example.test/notebooks', {
      userAgent: 'Electron B4M-Server-Conversations',
    });
    state.status = 'signed-out';
    h.listener?.();
    expect(h.close).toHaveBeenCalledOnce();
  });
  it('does not open for a signed-out account', async () => {
    registerSessionHandoff({ getState: () => ({ status: 'signed-out' }) } as unknown as AuthService);
    await h.handler?.();
    expect(h.options).toEqual([]);
  });
});

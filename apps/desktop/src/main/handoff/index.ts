import { createHash } from 'node:crypto';
import { BrowserWindow, ipcMain, shell } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import { isExternallyOpenable } from '@shared/externalLinks';
import { onAuthStateChanged, type AuthService } from '../auth';
import { markCompanionWindow } from '../windows';

export function registerSessionHandoff(auth: AuthService): void {
  let window: BrowserWindow | null = null;
  let scope: string | null = null;
  const currentScope = () => {
    const state = auth.getState();
    return state.status === 'signed-in' && state.user ? `${state.environment.url}:${state.user.id}` : null;
  };
  onAuthStateChanged(() => {
    if (scope === currentScope()) return;
    window?.close();
    window = null;
    scope = null;
  });
  ipcMain.handle(IPC_CHANNELS.handoffOpenServerSessions, async () => {
    const state = auth.getState();
    const nextScope = currentScope();
    if (!nextScope) return;
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
      return;
    }
    const base = new URL(state.environment.url);
    if (
      base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
    )
      return;
    scope = nextScope;
    const opened = new BrowserWindow({
      width: 1100,
      height: 800,
      title: 'Server conversations - sign in to continue',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: `persist:server-conversations-${createHash('sha256').update(nextScope).digest('hex')}`,
      },
    });
    window = opened;
    markCompanionWindow(opened);
    opened.webContents.setWindowOpenHandler(({ url }) => {
      if (isExternallyOpenable(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    opened.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin === base.origin) return;
      event.preventDefault();
      if (isExternallyOpenable(url)) void shell.openExternal(url);
    });
    opened.on('closed', () => {
      if (window === opened) {
        window = null;
        scope = null;
      }
    });
    await opened.loadURL(new URL('/notebooks', base).href, {
      userAgent: `${opened.webContents.getUserAgent()} B4M-Server-Conversations`,
    });
  });
}

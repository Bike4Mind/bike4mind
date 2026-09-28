import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { IPC_CHANNELS, type AppInfo } from '@shared/ipc';
import appIcon from '../../build/icon.png?asset';
import { registerAuth } from './auth';
import { registerChat } from './chat';
import { registerMediaScheme } from './chat/media/protocol';

// electron-vite sets this in dev only; a packaged build loads the renderer off disk.
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL;

// Before `whenReady`, which is the only point a scheme's privileges can still be declared;
// the handler that serves it is installed later, in registerChat.
registerMediaScheme();

function buildAppInfo(): AppInfo {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
  };
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: 'Bike4Mind',
    icon: appIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Showing only once the renderer has painted avoids a flash of empty chrome.
  window.once('ready-to-show', () => window.show());

  // A window opened in-app would inherit this app's session and privileges, so hand
  // every outbound link to the user's real browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (rendererDevUrl) {
    void window.loadURL(rendererDevUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

ipcMain.handle(IPC_CHANNELS.getAppInfo, buildAppInfo);

void app.whenReady().then(async () => {
  // macOS reads the dock icon from the app bundle, which only a packaged build has, so a
  // dev run would otherwise sit in the dock as Electron's own atom.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(appIcon);

  // After ready, not before: safeStorage is only usable once the app is ready, and the vault
  // asks it whether encryption is available on its first access.
  const auth = registerAuth();
  const { service: chat, background } = registerChat(auth);

  /**
   * Kill every background process before the app goes, in two passes.
   *
   * `before-quit` is the only hook that can wait, so the graceful pass lives here: the quit is
   * vetoed once, the process groups are SIGTERMed and given a moment to shut down cleanly (a
   * dev server releasing its port), and only then does the quit resume. `quitting` stops that
   * veto from looping forever, and Electron's own force-quit paths still land on `will-quit`
   * below, which SIGKILLs whatever survived.
   *
   * Neither of these runs if main is SIGKILLed or crashes. That case is covered inside the
   * child instead - see tools/backgroundScript.ts - because it is the case that actually
   * happened: a dev server from an earlier task held port 3000 for three days.
   */
  let quitting = false;
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void background
      .shutdown()
      .catch(() => undefined)
      .finally(() => app.quit());
  });

  app.once('will-quit', () => {
    auth.dispose();
    chat.dispose();
    // Synchronous and unconditional: this handler cannot await, and a quit that raced the
    // grace period above must not leave a process group behind.
    background.shutdownSync();
  });

  // Ctrl-C in a dev terminal, or a `kill` of the app. Our children are detached into their own
  // process groups precisely so one signal can reach a whole command tree - which also means a
  // terminal interrupt never reaches them on its own.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      background.shutdownSync();
      app.quit();
    });
  }

  createWindow();

  // Restoring runs alongside the window opening rather than gating it: the renderer starts in
  // the `initializing` state and is pushed the outcome, so a slow or unreachable backend
  // delays the auth card, not the whole app.
  void auth.initialize();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * Closing the last window is not quitting on macOS, and background processes are deliberately
 * left running through it: the app is still alive, the user reopens from the dock, and the
 * panel shows the same dev server still up. Everywhere else this quits, which runs the
 * teardown above.
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

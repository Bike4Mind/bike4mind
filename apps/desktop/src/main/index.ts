import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { IPC_CHANNELS, type AppInfo } from '@shared/ipc';
import appIcon from '../../build/icon.png?asset';
import { registerAuth } from './auth';
import { registerChat } from './chat';

// electron-vite sets this in dev only; a packaged build loads the renderer off disk.
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL;

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
  const chat = registerChat(auth);
  app.once('will-quit', () => {
    auth.dispose();
    chat.dispose();
  });

  createWindow();

  // Restoring runs alongside the window opening rather than gating it: the renderer starts in
  // the `initializing` state and is pushed the outcome, so a slow or unreachable backend
  // delays the auth card, not the whole app.
  void auth.initialize();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

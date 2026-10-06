import { join } from 'node:path';
import { BrowserWindow, type WebContents } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import { markDeveloperWindow } from '../windows';
import { isDevLogChord } from './chord';
import { devLog } from './DevLogSink';

// electron-vite sets this in dev only; a packaged build loads the renderer off disk.
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL;

/** The renderer route this window shows. Hash history, so it works over file:// too. */
const ROUTE = 'dev-logs';

let devWindow: BrowserWindow | null = null;

/**
 * Bind the chord on one window's contents.
 *
 * Window-scoped rather than `globalShortcut`, which registers system-wide and would take the
 * chord away from every other app on the machine. Bound in main rather than the renderer so it
 * fires with the caret in the composer, and so the dev window - which runs a different route -
 * gets it too.
 */
export function attachDevLogShortcut(contents: WebContents): void {
  contents.on('before-input-event', (event, input) => {
    if (!isDevLogChord(input)) return;
    event.preventDefault();
    toggleDevLogWindow();
  });
}

/** Open if closed, raise if open behind, close if it already has focus. */
export function toggleDevLogWindow(): void {
  if (!devWindow || devWindow.isDestroyed()) {
    devWindow = createDevLogWindow();
    return;
  }
  if (devWindow.isFocused()) {
    devWindow.close();
    return;
  }
  if (devWindow.isMinimized()) devWindow.restore();
  devWindow.show();
  devWindow.focus();
}

/** Closed with the last app window, so the dev window alone never holds the app open. */
export function closeDevLogWindow(): void {
  if (devWindow && !devWindow.isDestroyed()) devWindow.close();
}

function createDevLogWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 980,
    height: 620,
    show: false,
    title: 'Developer logs',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Not an app window: it must not receive the chat, auth or update broadcasts, must not keep
  // "reopen from the dock" from building a real window, and must not read as the app still
  // being open once the last real window has gone.
  markDeveloperWindow(window);
  // The renderer is one html document shared with the app, so its <title> would otherwise
  // rename this window to the app's name.
  window.on('page-title-updated', event => event.preventDefault());
  attachDevLogShortcut(window.webContents);

  // The sink captures only while a window is attached, so this is also what turns capture on.
  const detach = devLog.attach(records => {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.devLogRecords, records);
  });
  window.on('closed', () => {
    detach();
    if (devWindow === window) devWindow = null;
  });

  window.once('ready-to-show', () => window.show());
  if (rendererDevUrl) void window.loadURL(`${rendererDevUrl}#/${ROUTE}`);
  else void window.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/${ROUTE}` });
  return window;
}

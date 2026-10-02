import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { IPC_CHANNELS, type AppInfo } from '@shared/ipc';
import appIcon from '../../build/icon.png?asset';
import { registerAccount } from './account';
import { registerAuth } from './auth';
import { registerChat } from './chat';
import { registerArtifactScheme } from './chat/artifacts/sandboxProtocol';
import { registerMediaScheme } from './chat/media/protocol';
import { isExternallyOpenable } from './externalLinks';
import { registerUpdates } from './update';
import { appWindows } from './windows';

// electron-vite sets this in dev only; a packaged build loads the renderer off disk.
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL;

// Before `whenReady`, which is the only point a scheme's privileges can still be declared;
// the handlers that serve them are installed later, in registerChat.
registerMediaScheme();
registerArtifactScheme();

function buildAppInfo(): AppInfo {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
  };
}

/** Set once chat is registered; closes the agent's hidden browsers. */
let closeAgentBrowsers = (): void => undefined;

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
  // Hidden agent browsers would otherwise keep the app alive and `window-all-closed` from firing.
  window.on('closed', () => {
    if (appWindows().length === 0) closeAgentBrowsers();
  });

  // A window opened in-app would inherit this app's session and privileges, so hand
  // every outbound link to the user's real browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternallyOpenable(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // The window itself never navigates. Replies render links that route through
  // shell:open-external instead of following in place, so anything that reaches here is either
  // a link that missed that path or output trying to take the window somewhere - and either
  // way, navigating would swap the app, and the b4m bridge it is holding, for a web page.
  // A reload navigates to the url already loaded, which is not that and is left alone.
  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) return;
    event.preventDefault();
    if (isExternallyOpenable(url)) void shell.openExternal(url);
  });

  if (rendererDevUrl) {
    void window.loadURL(rendererDevUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

ipcMain.handle(IPC_CHANNELS.getAppInfo, buildAppInfo);

// Resolves either way: the renderer passes a url straight out of a reply, and a refusal is not
// something a link in a reply has any business being told about.
ipcMain.handle(IPC_CHANNELS.shellOpenExternal, (_event, url: unknown) => {
  if (typeof url === 'string' && isExternallyOpenable(url)) void shell.openExternal(url);
});

void app.whenReady().then(async () => {
  // macOS reads the dock icon from the app bundle, which only a packaged build has, so a
  // dev run would otherwise sit in the dock as Electron's own atom.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(appIcon);

  // After ready, not before: safeStorage is only usable once the app is ready, and the vault
  // asks it whether encryption is available on its first access.
  const auth = registerAuth();
  registerAccount(auth);
  const { service: chat, background, mcp, browser } = registerChat(auth);
  closeAgentBrowsers = () => browser.closeAll();

  // Set by whichever path starts the teardown, so the `before-quit` veto below runs at most
  // once. Declared here because the updater's install path does that teardown itself and must
  // not then be vetoed: quitAndInstall has already handed the app to the installer, and a
  // second graceful pass would only delay a quit whose children are already gone.
  let quitting = false;

  // Everything a quit would throw away, counted fresh each time it is asked for. The updater
  // puts this to the user rather than acting on it: a streaming reply and a dev server are both
  // things only they can say are expendable.
  const updates = registerUpdates({
    busy: () => {
      const statuses = chat.sessionStatuses();
      return {
        replying: statuses.filter(status => status.status === 'processing').length,
        awaitingApproval: statuses.filter(status => status.status === 'needs-action').length,
        background: background.runningCount(),
      };
    },
    prepareQuit: async () => {
      quitting = true;
      await Promise.all([background.shutdown(), mcp.shutdown(), browser.cookies.clearOnQuit()]).catch(() => undefined);
    },
  });

  /**
   * Kill every background process and MCP server child before the app goes, in two passes.
   *
   * `before-quit` is the only hook that can wait, so the graceful pass lives here: the quit is
   * vetoed once, the process groups are SIGTERMed and given a moment to shut down cleanly (a
   * dev server releasing its port), and only then does the quit resume. `quitting` stops that
   * veto from looping forever - and stops it firing at all after an update install, which has
   * already done this pass - and Electron's own force-quit paths still land on `will-quit`
   * below, which SIGKILLs whatever survived.
   *
   * Neither of these runs if main is SIGKILLed or crashes. For a background command that case
   * is covered inside the child instead - see tools/backgroundScript.ts - because it is the
   * case that actually happened: a dev server from an earlier task held port 3000 for three
   * days. A stdio MCP server has no such third line: it is someone else's program, and
   * wrapping it in a watchdog shell would put a layer between this app and the JSON-RPC stream
   * it speaks. An MCP child therefore survives a crash of main, and nothing else.
   */
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    // The imported cookies go too. They have no expiry and so were never written to disk, but
    // this is the pass that can await, and the guarantee is worth holding in two places.
    void Promise.all([background.shutdown(), mcp.shutdown(), browser.cookies.clearOnQuit()])
      .catch(() => undefined)
      .finally(() => app.quit());
  });

  app.once('will-quit', () => {
    auth.dispose();
    chat.dispose();
    updates.dispose();
    // Synchronous and unconditional: this handler cannot await, and a quit that raced the
    // grace period above must not leave a process group behind.
    background.shutdownSync();
    mcp.shutdownSync();
    browser.closeAll();
  });

  // Ctrl-C in a dev terminal, or a `kill` of the app. Our children are detached into their own
  // process groups precisely so one signal can reach a whole command tree - which also means a
  // terminal interrupt never reaches them on its own.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      background.shutdownSync();
      mcp.shutdownSync();
      app.quit();
    });
  }

  createWindow();

  // Restoring runs alongside the window opening rather than gating it: the renderer starts in
  // the `initializing` state and is pushed the outcome, so a slow or unreachable backend
  // delays the auth card, not the whole app.
  void auth.initialize();

  app.on('activate', () => {
    if (appWindows().length === 0) createWindow();
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

// First, before any module that could read userData or touch safeStorage; see appIdentity.ts.
import './bootstrapIdentity';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron';
import { IPC_CHANNELS, type AppInfo } from '@shared/ipc';
import { describeBusy, isBusy, type UpdateBusyReport } from '@shared/update';
import appIcon from '../../build/icon.png?asset';
import macAppIcon from '../../build/icon-mac.png?asset';
import { registerAccount } from './account';
import { registerAppMenu } from './appMenu';
import { currentVersion, currentVersionBasis } from './appVersion';
import { onAuthStateChanged, registerAuth } from './auth';
import { registerChat } from './chat';
import { localHostControl } from './host/localHostControl';
import { registerHostConnections } from './host/registerHostConnections';
import { electronSystemSignals } from './host/systemSignals';
import { sessionScopeFor, sessionScopeForChat, sessionScopeKey } from './chat/sessionScope';
import { closeBrowsersOnScopeChange } from './chat/browser/browserScope';
import { resolveUserPath } from './chat/tools/userPath';
import { attachDevLogShortcut, closeDevLogWindow, registerDevLog } from './devlog';
import { registerFleet } from './fleet';
import { registerModels } from './models';
import { registerArtifactScheme } from './chat/artifacts/sandboxProtocol';
import { registerModelScheme } from './chat/model3d/engineProtocol';
import { registerMediaScheme } from './chat/media/protocol';
import { isExternallyOpenable } from '@shared/externalLinks';
import { persistConsoleWarnings } from './logFile';
import { initialMainWindowPlacement, MainWindowStateStore, trackMainWindowState } from './mainWindowState';
import { registerSkinScheme } from './mods/skinProtocol';
import { registerSkins } from './mods';
import { registerRendererErrorLog } from './rendererErrors';
import { claimSingleInstance } from './singleInstance';
import { registerUpdates } from './update';
import { registerTerminals } from './terminal';
import { registerLocalUsage, registerUsage } from './usage';
import { registerAttention } from './attention';
import { appWindows } from './windows';
import { registerOrchestrateMini } from './orchestrateMini';
import { registerWatch } from './watch';
import { registerWindowTheme } from './windowTheme';
import { registerSessionHandoff } from './handoff';
import { runLiveEvaluation } from './chat/liveEvaluation';

// electron-vite sets this in dev only; a packaged build loads the renderer off disk.
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL;

// Before `whenReady`, which is the only point a scheme's privileges can still be declared;
// the handlers that serve them are installed later, in registerChat.
registerMediaScheme();
registerArtifactScheme();
registerModelScheme();
registerSkinScheme();

const mainWindowState = new MainWindowStateStore(join(app.getPath('userData'), 'main-window.json'));

function buildAppInfo(): AppInfo {
  const versionBasis = currentVersionBasis();
  return {
    appVersion: currentVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    homeDirectory: app.getPath('home'),
    ...(versionBasis ? { versionBasis } : {}),
  };
}

/** Set once chat is registered; closes the agent's hidden browsers. */
let closeAgentBrowsers = (): void => undefined;
let canCloseLastWindow = (): boolean => true;
/** Set once the watch is registered; closes the mini Tavern and the Orchestrate mini window (floatingWindow.ts). */
let closeFloatingWindows = (): void => undefined;

function createWindow(): void {
  const placement = initialMainWindowPlacement(
    mainWindowState.current(),
    screen.getAllDisplays().map(display => display.workArea)
  );
  const window = new BrowserWindow({
    ...placement.bounds,
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
  // maximize() shows the window too, so it stands in for show() rather than following it.
  window.once('ready-to-show', () => (placement.maximized ? window.maximize() : window.show()));
  trackMainWindowState(window, mainWindowState);
  window.on('close', event => {
    if (process.platform === 'darwin' || canCloseLastWindow()) return;
    if (appWindows().some(other => other !== window)) return;
    // Keep the last window available if the user cancels the quit confirmation.
    event.preventDefault();
    app.quit();
  });
  // Hidden agent browsers would otherwise keep the app alive and `window-all-closed` from
  // firing. The developer log window is excluded from `appWindows` for the same reason, so it
  // is closed here too rather than being left as the one window holding the app open.
  window.on('closed', () => {
    if (appWindows().length > 0) return;
    closeAgentBrowsers();
    closeDevLogWindow();
    // macOS keeps running with no window, and the floating windows are how a watcher keeps an eye on it.
    // Elsewhere the last window closing quits, which needs them gone too.
    if (process.platform !== 'darwin') closeFloatingWindows();
  });

  attachDevLogShortcut(window.webContents);

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

/** Bring the main window forward, opening one if none is (macOS keeps running with none). */
function showMainWindow(): void {
  const window = appWindows()[0];
  if (!window) return createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  // A second launch arrives while another app is frontmost; focus() alone only raises the window.
  if (process.platform === 'darwin') app.focus({ steal: true });
}

ipcMain.handle(IPC_CHANNELS.getAppInfo, buildAppInfo);
registerRendererErrorLog();
registerWindowTheme();

registerDevLog();

// Resolves either way: the renderer passes a url straight out of a reply, and a refusal is not
// something a link in a reply has any business being told about.
ipcMain.handle(IPC_CHANNELS.shellOpenExternal, (_event, url: unknown) => {
  if (typeof url === 'string' && isExternallyOpenable(url)) void shell.openExternal(url);
});

function sessionScopeKeyOf(state: Parameters<typeof sessionScopeFor>[0]): string | null {
  const scope = sessionScopeFor(state);
  return scope ? sessionScopeKey(scope) : null;
}

void app.whenReady().then(async () => {
  let quitState: 'idle' | 'confirming' | 'cleaning-up' | 'ready' = 'idle';
  // First, before anything that touches the profile. After ready rather than at import: taken
  // before ready while a previous instance is still quitting, the lock can leave macOS never
  // finishing this launch, so the app sits in the dock with no window. Here it waits for the old
  // instance to let go and carries on. A launch during a quit is not brought forward: the window
  // it would raise is closing.
  const onSecondLaunch = () => {
    if (quitState === 'idle') showMainWindow();
  };
  if (!claimSingleInstance(app, onSecondLaunch)) {
    app.exit(0);
    return;
  }
  // Right after the lock, so a failure below is on disk too (a packaged build has no terminal);
  // warnings before app ready are not persisted.
  persistConsoleWarnings(console, app.getPath('logs'));
  // Started now so the first command or PR poll does not wait on a slow login shell.
  void resolveUserPath();

  // macOS reads the dock icon from the app bundle, which only a packaged build has, so a
  // dev run would otherwise sit in the dock as Electron's own atom.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(macAppIcon);

  // After ready, not before: safeStorage is only usable once the app is ready, and the vault
  // asks it whether encryption is available on its first access.
  const auth = registerAuth();
  registerSessionHandoff(auth, app.getPath('userData'));
  const attention = registerAttention({
    openWindow: createWindow,
    notifyScopePath: join(app.getPath('userData'), 'attention-preferences.json'),
  });
  registerAccount(auth);
  registerUsage(auth);
  const fleet = registerFleet();
  const {
    service: chat,
    background,
    mcp,
    browser,
    simulatorView,
    modelViews,
    pullRequests,
    composerDrafts,
    claudeImport,
    spareWorktrees,
    modelServers,
    stopModelServers,
    stopLocalServers,
    localContext,
    modelSettings,
    capabilityLedger,
    respondToApproval,
    store: sessions,
    host,
  } = registerChat(auth, {
    sessionClosed: sessionId => terminals.killSession(sessionId),
    releaseSessionTerminals: sessionId => terminals.acquireSessionCleanup(sessionId),
    observeStream: event => {
      fleet.observe(event);
      watch.observeStream(event);
    },
    observeSessionStatus: event => {
      needsYou.observe(event);
      watch.observeStatus(event);
    },
    cancelModelPull: key => models.stop(key),
    pinnedProjectors: () => models.pinnedProjectors(),
    catalogSampling: ({ name, modelBlob, parameters, hasAdapter }) =>
      models.catalogSampling(name, modelBlob, parameters, hasAdapter),
  });
  const hostConnections = registerHostConnections(host, {
    control: localHostControl({
      auth,
      onAuthStateChanged,
      dataDirectory: app.getPath('userData'),
      homeDirectory: app.getPath('home'),
      version: currentVersion(),
      log: message => host.logger.warn(message),
    }),
    auth,
    onAuthStateChanged,
    version: currentVersion(),
    signals: electronSystemSignals(),
  });
  const models = registerModels(
    modelServers,
    { localContext: () => localContext.read(), modelSettings: modelId => modelSettings.get(modelId) },
    capabilityLedger
  );
  const needsYou = attention.watchNeedsYou({
    listSessions: () => chat.listSessions(),
    sessionMessages: async sessionId => (await chat.getSession(sessionId))?.messages ?? [],
  });
  // The Orchestrate mini window: fed by the stage, toggled from its view menu and the menu-bar item.
  const orchestrateMini = registerOrchestrateMini({
    openSession: open => attention.openSession(open),
    isQuitting: () => quitState === 'cleaning-up' || quitState === 'ready',
    ...(rendererDevUrl ? { rendererDevUrl } : {}),
  });
  // The menu-bar item and the mini Tavern: the same status feed and approval gate as above.
  const watch = registerWatch({
    sources: {
      listSessions: () => chat.listSessions(),
      sessionStatuses: () => chat.sessionStatuses(),
      sessionMessages: async sessionId => (await chat.getSession(sessionId))?.messages ?? [],
      resolveApproval: respondToApproval,
    },
    openSession: open => attention.openSession(open),
    showApp: showMainWindow,
    appIcon,
    isQuitting: () => quitState === 'cleaning-up' || quitState === 'ready',
    ...(rendererDevUrl ? { rendererDevUrl } : {}),
    orchestrateMini,
  });
  closeFloatingWindows = () => {
    watch.closeMini();
    orchestrateMini.close();
  };
  void watch.start();
  void orchestrateMini.start();
  const chatScopeKeyOf = (state: Parameters<typeof sessionScopeForChat>[0]) => {
    const scope = sessionScopeForChat(state);
    return scope ? sessionScopeKey(scope) : null;
  };
  let needsYouScope = chatScopeKeyOf(auth.getState());
  onAuthStateChanged(state => {
    const next = chatScopeKeyOf(state);
    if (next !== needsYouScope || state.busy === 'signing-out' || state.reauthRequired) chat.clearLoops();
    if (next === needsYouScope) return;
    needsYouScope = next;
    needsYou.scopeChanged();
    watch.scopeChanged();
  });
  registerLocalUsage(auth, sessions, modelServers);
  fleet.setDirectoryResolver(async sessionId => {
    const session = await chat.getSession(sessionId);
    return session?.project?.workingDirectory ?? session?.grantedDirectories?.[0] ?? null;
  });
  fleet.setModelResolver(async sessionId => (await chat.getSession(sessionId))?.model ?? null);
  closeAgentBrowsers = () => browser.closeAll();
  const terminals = registerTerminals(async sessionId => {
    const session = await chat.getSession(sessionId);
    return session?.project?.workingDirectory ?? session?.grantedDirectories?.[0] ?? null;
  });

  let signalQuit = false;
  canCloseLastWindow = () => quitState === 'ready';

  const busyReport = (): UpdateBusyReport => {
    const statuses = chat.sessionStatuses();
    return {
      replying: statuses.filter(status => status.status === 'processing').length,
      awaitingApproval: statuses.filter(status => status.status === 'needs-action').length,
      background: background.runningCount(),
      terminals: terminals.runningCount(),
      modelDownloads: models.runningCount(),
      modelServers: modelServers.runningLocalServerCount(),
    };
  };

  const prepareQuit = async () => {
    quitState = 'cleaning-up';
    const results = await Promise.allSettled([
      background.shutdown(),
      mcp.shutdown(),
      terminals.shutdown(),
      browser.cookies.clearOnQuit(),
      spareWorktrees.dispose(),
      stopLocalServers(),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') console.warn('QUIT: cleanup failed', result.reason);
    }
    quitState = 'ready';
  };

  registerSkins();

  // Everything a quit would throw away, counted fresh each time it is asked for. The updater
  // puts this to the user rather than acting on it: a streaming reply and a dev server are both
  // things only they can say are expendable.
  const updates = registerUpdates({
    busy: busyReport,
    prepareQuit,
  });

  const requestQuit = async () => {
    quitState = 'confirming';
    try {
      const busy = busyReport();
      if (!signalQuit && isBusy(busy)) {
        const { response } = await dialog.showMessageBox({
          type: 'warning',
          title: 'Quit Bike4Mind?',
          message: 'Background work is still active. Quit anyway?',
          detail: `${describeBusy(busy)}\n\nQuitting will interrupt active agents and downloads, close terminals, and stop background processes and model servers started by Desktop.`,
          buttons: ['Keep Running', 'Quit Anyway'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        // A signal or updater may have started cleanup while the dialog was open.
        if (quitState !== 'confirming') return;
        if (response !== 1) {
          quitState = 'idle';
          return;
        }
      }
      await prepareQuit();
      // Let Electron finish cancelling the native quit before starting another one on macOS.
      setImmediate(() => app.quit());
    } catch (error) {
      if (quitState === 'confirming') quitState = 'idle';
      console.warn('QUIT: could not prepare to quit', error);
    }
  };

  /**
   * Kill every background process and MCP server child before the app goes, in two passes.
   *
   * `before-quit` is the only hook that can wait, so the graceful pass lives here: the quit is
   * vetoed until the user confirms any active work and cleanup finishes. The process groups
   * are SIGTERMed and given a moment to shut down cleanly (a dev server releasing its port),
   * and only then does the quit resume. The ready state lets a resumed quit or a prepared
   * update install proceed without another veto. `will-quit` below SIGKILLs whatever survived.
   *
   * Neither of these runs if main is SIGKILLed or crashes. For a background command that case
   * is covered inside the child instead - see tools/backgroundScript.ts - because it is the
   * case that actually happened: a dev server from an earlier task held port 3000 for three
   * days. A stdio MCP server has no such third line: it is someone else's program, and
   * wrapping it in a watchdog shell would put a layer between this app and the JSON-RPC stream
   * it speaks. An MCP child therefore survives a crash of main, and nothing else.
   */
  app.on('before-quit', event => {
    if (quitState === 'ready') return;
    event.preventDefault();
    if (quitState === 'cleaning-up' || (quitState === 'confirming' && !signalQuit)) return;
    void requestQuit();
  });

  app.once('will-quit', () => {
    composerDrafts.flushSync();
    auth.dispose();
    fleet.dispose();
    models.dispose();
    chat.dispose();
    hostConnections.dispose();
    stopModelServers();
    claudeImport.dispose();
    pullRequests.dispose();
    updates.dispose();
    // Synchronous and unconditional: this handler cannot await, and a quit that raced the
    // grace period above must not leave a process group behind.
    background.shutdownSync();
    mcp.shutdownSync();
    terminals.shutdownSync();
    browser.closeAll();
    simulatorView.dispose();
    modelViews.dispose();
  });

  // Ctrl-C in a dev terminal, or a `kill` of the app. Children other than WSL commands lead their own
  // process groups, so a terminal interrupt does not reach them on its own (see `spawnsDetached`).
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      signalQuit = true;
      background.shutdownSync();
      mcp.shutdownSync();
      terminals.shutdownSync();
      app.quit();
    });
  }

  registerAppMenu({ showApp: showMainWindow, version: currentVersion() });
  await mainWindowState.load();
  createWindow();
  claudeImport.start();
  app.on('browser-window-focus', () => claudeImport.onWindowFocus());
  // Blur fires before the next window's focus; check after it settles so a hop between windows keeps polling.
  app.on('browser-window-blur', () =>
    setImmediate(() => {
      if (!BrowserWindow.getFocusedWindow()) claudeImport.onAppBlur();
    })
  );
  onAuthStateChanged(closeBrowsersOnScopeChange(auth.getState(), () => browser.closeAll()));
  let importScope = sessionScopeKeyOf(auth.getState());
  onAuthStateChanged(state => {
    const next = sessionScopeKeyOf(state);
    if (next === importScope) return;
    importScope = next;
    claudeImport.onScopeChanged();
  });

  // Restoring runs alongside the window opening rather than gating it: the renderer starts in
  // the `initializing` state and is pushed the outcome, so a slow or unreachable backend
  // delays the auth card, not the whole app.
  void auth.initialize().then(
    () =>
      runLiveEvaluation(
        auth,
        join(app.getPath('userData'), 'controlled-evaluation'),
        process.argv.includes('--controlled-cost-evaluation-live'),
        process.argv
          .find(argument => argument.startsWith('--controlled-cost-evaluation-config='))
          ?.split('=')
          .slice(1)
          .join('='),
        {
          finalPhase: process.argv.includes('--controlled-cost-evaluation-final'),
          recoverRunId: process.argv
            .find(argument => argument.startsWith('--controlled-cost-evaluation-recover-run='))
            ?.split('=')[1],
        }
      ).catch((error: unknown) => console.warn('EVALUATION: stopped; inspect the local evaluation report.', error)),
    (error: unknown) => console.error('Auth restore failed at startup', error)
  );

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

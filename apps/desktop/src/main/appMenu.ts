import { app, ipcMain, Menu, shell, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AppMenuAction } from '@shared/appShell';
import { focusedAppWindow } from './windows';

export const DOCS_URL = 'https://docs.bike4mind.com';

export type AppMenuTemplateOptions = {
  appName: string;
  platform: NodeJS.Platform;
  /** A dev run (`pnpm dev`) also gets reload and the devtools toggle. */
  isDev: boolean;
  runAction(action: AppMenuAction): void;
  openDocs(): void;
};

const SETTINGS_LABEL = 'Settings\u2026';

/**
 * The menu bar as a template. The Edit menu is roles only: they are what route Cmd+C, Cmd+V,
 * Cmd+Z and Cmd+A to whichever text field has focus, the composer included. Without them macOS
 * has no menu item to dispatch those chords through. Off macOS there is no app menu, so
 * Settings and Quit move to File and About to Help, where those platforms keep them.
 */
export function buildAppMenuTemplate(options: AppMenuTemplateOptions): MenuItemConstructorOptions[] {
  const isMac = options.platform === 'darwin';
  const settings: MenuItemConstructorOptions = {
    label: SETTINGS_LABEL,
    accelerator: 'CmdOrCtrl+,',
    click: () => options.runAction('open-settings'),
  };
  const newChat: MenuItemConstructorOptions = {
    label: 'New Chat',
    accelerator: 'CmdOrCtrl+N',
    click: () => options.runAction('new-chat'),
  };

  const appMenu: MenuItemConstructorOptions = {
    label: options.appName,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      settings,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: isMac
      ? [newChat, { type: 'separator' }, { role: 'close' }]
      : [newChat, { type: 'separator' }, settings, { type: 'separator' }, { role: 'close' }, { role: 'quit' }],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac ? ([{ role: 'pasteAndMatchStyle' }] as const) : []),
      { role: 'delete' },
      { role: 'selectAll' },
    ],
  };

  const devItems: MenuItemConstructorOptions[] = options.isDev
    ? [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }]
    : [];
  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      ...devItems,
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = { role: 'windowMenu' };

  const helpMenu: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      { label: `${options.appName} Documentation`, click: () => options.openDocs() },
      ...(isMac ? [] : ([{ type: 'separator' }, { role: 'about' }] as const)),
    ],
  };

  return [...(isMac ? [appMenu] : []), fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
}

export type AppMenuDeps = {
  /** Show the main window, creating one if none is open (macOS keeps running with none). */
  showApp(): void;
  /** The version About shows; a packaged build's own would be package.json's. */
  version: string;
};

/**
 * Install the menu bar and carry its actions to the renderer. An action is sent only to a page
 * whose bridge has subscribed (it calls takePending on mount); otherwise it waits for the bridge
 * to take it, the same handoff attention uses for a clicked notice. Readiness is the bridge's own
 * signal rather than webContents.isLoading(), which can stay true after the bridge has mounted.
 */
export function registerAppMenu({ showApp, version }: AppMenuDeps): void {
  app.setAboutPanelOptions({ applicationName: 'Bike4Mind', applicationVersion: version });
  let pending: AppMenuAction | null = null;
  const listening = new WeakSet<WebContents>();

  const runAction = (action: AppMenuAction) => {
    const window = focusedAppWindow();
    if (!window || !listening.has(window.webContents)) {
      pending = action;
      showApp();
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.webContents.send(IPC_CHANNELS.appMenuAction, action);
  };

  ipcMain.handle(IPC_CHANNELS.appMenuTakePending, (event): AppMenuAction | null => {
    const contents = event.sender;
    if (!listening.has(contents)) {
      listening.add(contents);
      // A reload or new document drops the bridge until it mounts and asks again.
      const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (!details.isMainFrame || details.isSameDocument) return;
        listening.delete(contents);
        contents.off('did-start-navigation', onNavigation);
      };
      contents.on('did-start-navigation', onNavigation);
    }
    const action = pending;
    pending = null;
    return action;
  });

  const template = buildAppMenuTemplate({
    appName: 'Bike4Mind',
    platform: process.platform,
    isDev: !app.isPackaged,
    runAction,
    openDocs: () => void shell.openExternal(DOCS_URL),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

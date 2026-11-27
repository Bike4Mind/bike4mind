import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { currentVersion, currentVersionBasis } from './appVersion';
import { devLog } from './devlog/DevLogSink';

// One electron for the main-process modules that register handlers or read the app at import time.
const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  template: null as unknown,
  focused: undefined as unknown,
  openExternal: vi.fn(),
}));
const { app, handle, nativeTheme, windows } = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: () => '0.1.16', setAboutPanelOptions: vi.fn() },
  handle: vi.fn(),
  nativeTheme: { themeSource: 'system' },
  windows: [
    { webContents: {}, setBackgroundColor: vi.fn() },
    { webContents: {}, setBackgroundColor: vi.fn() },
  ],
}));

vi.mock('electron', () => ({
  app,
  ipcMain: { handle },
  nativeTheme,
  Menu: {
    buildFromTemplate: (template: unknown) => {
      harness.template = template;
      return template;
    },
    setApplicationMenu: vi.fn(),
  },
  shell: { openExternal: harness.openExternal },
}));
vi.mock('./windows', () => ({ focusedAppWindow: () => harness.focused, appWindows: () => windows }));

const { buildAppMenuTemplate, DOCS_URL, registerAppMenu } = await import('./appMenu');
const { registerRendererErrorLog } = await import('./rendererErrors');
const { registerWindowTheme } = await import('./windowTheme');

beforeEach(() => {
  handle.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) =>
    harness.handlers.set(channel, handler)
  );
});

describe('app menu', () => {
  type Item = MenuItemConstructorOptions;

  function submenu(template: Item[], label: string): Item[] {
    const menu = template.find(item => item.label === label || item.role === label);
    if (!menu || !Array.isArray(menu.submenu)) throw new Error(`no ${label} menu`);
    return menu.submenu;
  }

  function item(items: Item[], label: string): Item {
    const found = items.find(entry => entry.label === label);
    if (!found) throw new Error(`no ${label} item`);
    return found;
  }

  function click(entry: Item): void {
    // The handlers ignore their arguments, so the menu item, window and event can be stand-ins.
    (entry.click as () => void)();
  }

  const roles = (items: Item[]) => items.map(entry => entry.role).filter(Boolean);

  function build(overrides: Partial<Parameters<typeof buildAppMenuTemplate>[0]> = {}) {
    const runAction = vi.fn();
    const openDocs = vi.fn();
    const template = buildAppMenuTemplate({
      appName: 'Bike4Mind',
      platform: 'darwin',
      isDev: false,
      runAction,
      openDocs,
      ...overrides,
    });
    return { template, runAction, openDocs };
  }

  describe('buildAppMenuTemplate', () => {
    it('lays out the macOS menu bar', () => {
      const { template } = build();
      expect(template.map(menu => menu.label ?? menu.role)).toEqual([
        'Bike4Mind',
        'File',
        'Edit',
        'View',
        'windowMenu',
        'help',
      ]);
      expect(roles(submenu(template, 'Bike4Mind'))).toEqual(
        expect.arrayContaining(['about', 'hide', 'hideOthers', 'unhide', 'quit'])
      );
    });

    it('binds Settings to Cmd+, and New Chat to Cmd+N, each carrying its action', () => {
      const { template, runAction } = build();
      const settings = item(submenu(template, 'Bike4Mind'), 'Settings\u2026');
      const newChat = item(submenu(template, 'File'), 'New Chat');
      expect(settings.accelerator).toBe('CmdOrCtrl+,');
      expect(newChat.accelerator).toBe('CmdOrCtrl+N');

      click(settings);
      click(newChat);
      expect(runAction.mock.calls).toEqual([['open-settings'], ['new-chat']]);
    });

    it('gives the Edit menu the roles that route clipboard and undo chords to text fields', () => {
      const { template } = build();
      expect(roles(submenu(template, 'Edit'))).toEqual(
        expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
      );
    });

    it('keeps reload and devtools out of a packaged build', () => {
      const packaged = roles(submenu(build().template, 'View'));
      expect(packaged).not.toEqual(expect.arrayContaining(['reload']));
      expect(packaged).not.toContain('toggleDevTools');
      expect(packaged).toEqual(expect.arrayContaining(['resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen']));

      const dev = roles(submenu(build({ isDev: true }).template, 'View'));
      expect(dev).toEqual(expect.arrayContaining(['reload', 'toggleDevTools']));
    });

    it('opens the docs from Help', () => {
      const { template, openDocs } = build();
      click(item(submenu(template, 'help'), 'Bike4Mind Documentation'));
      expect(openDocs).toHaveBeenCalledTimes(1);
    });

    it('moves Settings and Quit to File and About to Help off macOS', () => {
      const { template, runAction } = build({ platform: 'win32' });
      expect(template.map(menu => menu.label ?? menu.role)).toEqual(['File', 'Edit', 'View', 'windowMenu', 'help']);
      const file = submenu(template, 'File');
      expect(roles(file)).toContain('quit');
      click(item(file, 'Settings\u2026'));
      expect(runAction).toHaveBeenCalledWith('open-settings');
      expect(roles(submenu(template, 'help'))).toContain('about');
    });
  });

  describe('registerAppMenu', () => {
    beforeEach(() => {
      app.isPackaged = true;
      harness.handlers.clear();
      harness.template = null;
      harness.focused = undefined;
    });

    type NavigationListener = (details: { isMainFrame: boolean; isSameDocument: boolean }) => void;

    function fakeWindow() {
      const navigation = new Set<NavigationListener>();
      const webContents = {
        send: vi.fn(),
        on: (_event: string, listener: NavigationListener) => navigation.add(listener),
        off: (_event: string, listener: NavigationListener) => navigation.delete(listener),
        navigate: (details: { isMainFrame: boolean; isSameDocument: boolean }) =>
          [...navigation].forEach(listener => listener(details)),
      };
      return { isMinimized: vi.fn(() => true), restore: vi.fn(), show: vi.fn(), focus: vi.fn(), webContents };
    }

    // Wherever this platform puts it: Settings is in the app menu on macOS and in File elsewhere.
    function menuAction(label: string): void {
      const everyItem = (harness.template as Item[]).flatMap(menu => (Array.isArray(menu.submenu) ? menu.submenu : []));
      click(item(everyItem, label));
    }

    // The renderer's AppMenuBridge calls this on mount; it also marks that page as listening.
    const takePending = (sender: unknown = fakeWindow().webContents) =>
      harness.handlers.get(IPC_CHANNELS.appMenuTakePending)?.({ sender });

    it('sends an action to a window whose bridge is listening, bringing it forward', () => {
      const window = fakeWindow();
      harness.focused = window;
      const showApp = vi.fn();
      registerAppMenu({ showApp, version: '1.0.0' });
      expect(takePending(window.webContents)).toBeNull();

      menuAction('New Chat');
      expect(window.restore).toHaveBeenCalled();
      expect(window.focus).toHaveBeenCalled();
      expect(window.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.appMenuAction, 'new-chat');
      expect(showApp).not.toHaveBeenCalled();
      expect(takePending(window.webContents)).toBeNull();
    });

    it('holds an action chosen with no window open for the window it opens, once', () => {
      const showApp = vi.fn();
      registerAppMenu({ showApp, version: '1.0.0' });

      menuAction('Settings\u2026');
      expect(showApp).toHaveBeenCalledTimes(1);
      expect(takePending()).toBe('open-settings');
      expect(takePending()).toBeNull();
    });

    it('holds an action for a window whose bridge has not mounted yet', () => {
      const window = fakeWindow();
      harness.focused = window;
      registerAppMenu({ showApp: vi.fn(), version: '1.0.0' });

      menuAction('New Chat');
      expect(window.webContents.send).not.toHaveBeenCalled();
      expect(takePending(window.webContents)).toBe('new-chat');
    });

    it('holds actions again while a reloaded page has not remounted its bridge', () => {
      const window = fakeWindow();
      harness.focused = window;
      registerAppMenu({ showApp: vi.fn(), version: '1.0.0' });
      takePending(window.webContents);

      window.webContents.navigate({ isMainFrame: true, isSameDocument: true });
      menuAction('New Chat');
      expect(window.webContents.send).toHaveBeenCalledTimes(1);

      window.webContents.navigate({ isMainFrame: true, isSameDocument: false });
      menuAction('New Chat');
      expect(window.webContents.send).toHaveBeenCalledTimes(1);
      expect(takePending(window.webContents)).toBe('new-chat');
    });

    it('opens the documentation in the browser', () => {
      registerAppMenu({ showApp: vi.fn(), version: '1.0.0' });
      menuAction('Bike4Mind Documentation');
      expect(harness.openExternal).toHaveBeenCalledWith(DOCS_URL);
    });
  });
});

describe('app version', () => {
  const DEV = '0.203.0-dev.gabc123def456.dirty';
  const BASIS = 'newest local tag desktop-v0.203.0 (2026-11-13); run git fetch origin --tags if that looks old';

  afterEach(() => vi.unstubAllGlobals());

  function bake(version: string, basis: string): void {
    vi.stubGlobal('__B4M_DEV_VERSION__', version);
    vi.stubGlobal('__B4M_DEV_VERSION_BASIS__', basis);
  }

  describe('currentVersion', () => {
    it('reports the app version for a packaged build, whatever was baked in', () => {
      app.isPackaged = true;
      bake(DEV, BASIS);
      expect(currentVersion()).toBe('0.1.16');
      expect(currentVersionBasis()).toBeUndefined();
    });

    it('reports the baked dev version for an unpackaged run', () => {
      app.isPackaged = false;
      bake(DEV, BASIS);
      expect(currentVersion()).toBe(DEV);
      expect(currentVersionBasis()).toBe(BASIS);
    });

    it('falls back to the app version when nothing was baked in', () => {
      app.isPackaged = false;
      bake('', '');
      expect(currentVersion()).toBe('0.1.16');
      expect(currentVersionBasis()).toBeUndefined();
    });

    it('has no basis to show when only the version was baked in', () => {
      app.isPackaged = false;
      bake(DEV, '');
      expect(currentVersionBasis()).toBeUndefined();
    });
  });

  describe('main-process version readers', () => {
    it('only appVersion.ts calls app.getVersion()', () => {
      const files = readdirSync(__dirname, { recursive: true, encoding: 'utf8' }).filter(
        file => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file)
      );
      expect(files).toContain('index.ts');
      const offenders = files.filter(
        file => file !== 'appVersion.ts' && /\bapp\.getVersion\s*\(/.test(readFileSync(join(__dirname, file), 'utf8'))
      );
      expect(offenders).toEqual([]);
    });
  });
});

describe('renderer error log', () => {
  describe('registerRendererErrorLog', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      devLog.clear();
    });

    const send = (payload: unknown) => {
      registerRendererErrorLog();
      harness.handlers.get(IPC_CHANNELS.rendererReportError)?.({}, payload);
    };

    it('writes a render error to the main log', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      send({ message: 'boom', stack: 'Error: boom\n    at Sidebar', route: '#/settings' });
      expect(error).toHaveBeenCalledWith('RENDERER: render error on #/settings: boom', '\nError: boom\n    at Sidebar');
    });

    it('drops a malformed report', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      send({ message: 42 });
      expect(error).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('RENDERER: dropped a malformed error report');
    });

    it('also keeps an errors record, with no window attached', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      send({ message: 'boom', stack: 'Error: boom', componentStack: '\n at X', route: '#/settings' });
      const { records } = devLog.snapshot();
      expect(records).toHaveLength(1);
      expect(records[0].tags).toEqual(['renderer', 'errors']);
      expect(records[0].message).toBe('boom');
      expect(records[0].fields).toEqual({ source: 'renderer', kind: 'render', route: '#/settings' });
    });

    it('keeps no record for a malformed report', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      send({ message: 42 });
      expect(devLog.snapshot().records).toHaveLength(0);
    });
  });
});

describe('window theme', () => {
  describe('native window theme', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      nativeTheme.themeSource = 'system';
      registerWindowTheme();
    });

    it.each(['light', 'dark', 'system'])('applies %s appearance and background to app windows', mode => {
      expect(handle).toHaveBeenCalledWith(IPC_CHANNELS.setTheme, expect.any(Function));
      handle.mock.calls[0][1]({ sender: windows[0].webContents }, mode, '#123abc');
      expect(nativeTheme.themeSource).toBe(mode);
      for (const window of windows) expect(window.setBackgroundColor).toHaveBeenCalledWith('#123abc');
    });

    it.each([
      ['invalid', '#123abc'],
      ['dark', 'invalid'],
      ['light', null],
    ])('ignores invalid theme input %s / %s', (mode, color) => {
      handle.mock.calls[0][1]({ sender: windows[0].webContents }, mode, color);
      expect(nativeTheme.themeSource).toBe('system');
      for (const window of windows) expect(window.setBackgroundColor).not.toHaveBeenCalled();
    });

    it('ignores messages from non-app windows', () => {
      handle.mock.calls[0][1]({ sender: {} }, 'dark', '#123abc');
      expect(nativeTheme.themeSource).toBe('system');
      for (const window of windows) expect(window.setBackgroundColor).not.toHaveBeenCalled();
    });
  });
});

import type { MenuItemConstructorOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  template: null as unknown,
  focused: undefined as unknown,
  openExternal: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: true, setAboutPanelOptions: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => harness.handlers.set(channel, handler),
  },
  Menu: {
    buildFromTemplate: (template: unknown) => {
      harness.template = template;
      return template;
    },
    setApplicationMenu: vi.fn(),
  },
  shell: { openExternal: harness.openExternal },
}));
vi.mock('./windows', () => ({ focusedAppWindow: () => harness.focused }));

const { buildAppMenuTemplate, DOCS_URL, registerAppMenu } = await import('./appMenu');

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
    harness.handlers.clear();
    harness.template = null;
    harness.focused = undefined;
  });

  function fakeWindow(loading = false) {
    return {
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { isLoading: () => loading, send: vi.fn() },
    };
  }

  // Wherever this platform puts it: Settings is in the app menu on macOS and in File elsewhere.
  function menuAction(label: string): void {
    const everyItem = (harness.template as Item[]).flatMap(menu => (Array.isArray(menu.submenu) ? menu.submenu : []));
    click(item(everyItem, label));
  }

  const takePending = () => harness.handlers.get(IPC_CHANNELS.appMenuTakePending)?.();

  it('sends an action to the window, bringing it forward', () => {
    const window = fakeWindow();
    harness.focused = window;
    const showApp = vi.fn();
    registerAppMenu({ showApp, version: '1.0.0' });

    menuAction('New Chat');
    expect(window.restore).toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalled();
    expect(window.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.appMenuAction, 'new-chat');
    expect(showApp).not.toHaveBeenCalled();
    expect(takePending()).toBeNull();
  });

  it('holds an action chosen with no window open for the window it opens, once', () => {
    const showApp = vi.fn();
    registerAppMenu({ showApp, version: '1.0.0' });

    menuAction('Settings\u2026');
    expect(showApp).toHaveBeenCalledTimes(1);
    expect(takePending()).toBe('open-settings');
    expect(takePending()).toBeNull();
  });

  it('holds an action for a window that is still loading', () => {
    const window = fakeWindow(true);
    harness.focused = window;
    registerAppMenu({ showApp: vi.fn(), version: '1.0.0' });

    menuAction('New Chat');
    expect(window.webContents.send).not.toHaveBeenCalled();
    expect(takePending()).toBe('new-chat');
  });

  it('opens the documentation in the browser', () => {
    registerAppMenu({ showApp: vi.fn(), version: '1.0.0' });
    menuAction('Bike4Mind Documentation');
    expect(harness.openExternal).toHaveBeenCalledWith(DOCS_URL);
  });
});

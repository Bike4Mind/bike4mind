import { join } from 'node:path';
import { BrowserWindow, app, screen, shell, type Rectangle, type WebContents } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import { isExternallyOpenable } from '@shared/externalLinks';
import type { WatchBounds, WatchSnapshot } from '@shared/watch';
import { markCompanionWindow } from '../windows';
import type { WatchPreferencesStore } from './WatchPreferencesStore';

export const MINI_DEFAULT_SIZE = { width: 360, height: 220 } as const;
export const MINI_MIN_SIZE = { width: 220, height: 56 } as const;
/** Moves and resizes arrive per frame while dragging; the file only needs the last one. */
export const BOUNDS_SAVE_DELAY_MS = 400;

/** The renderer route this window shows; hash history, so it works over file:// too. */
const ROUTE = 'mini-tavern';

/**
 * Saved bounds, if they still land on a screen. A window saved on an unplugged display would
 * otherwise reopen somewhere it cannot be seen or dragged back from; null means "use the default".
 */
export function restoreBounds(saved: WatchBounds | null, workAreas: readonly Rectangle[]): WatchBounds | null {
  if (!saved) return null;
  const visible = workAreas.some(area => {
    const overlapX = Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x);
    const overlapY = Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y);
    // Enough of it on this screen to grab: its top strip is the drag handle.
    return overlapX >= 40 && overlapY >= 24 && saved.y >= area.y;
  });
  if (!visible) return null;
  return {
    ...saved,
    width: Math.max(saved.width, MINI_MIN_SIZE.width),
    height: Math.max(saved.height, MINI_MIN_SIZE.height),
  };
}

export interface MiniWindowController {
  show(): void;
  hide(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Whether an IPC call came from the mini window: its surface answers nobody else. */
  owns(sender: WebContents): boolean;
  push(snapshot: WatchSnapshot): void;
  onVisibilityChanged(listener: (open: boolean) => void): void;
}

export type MiniWindowDeps = {
  preferences: WatchPreferencesStore;
  /** electron-vite's dev server; absent in a packaged build, which loads the renderer off disk. */
  rendererDevUrl?: string;
};

/**
 * The always-on-top mini Tavern: a small frameless window that floats over other apps, on every
 * Space and over full-screen apps, and remembers where it was and whether it was open.
 */
export function createMiniWindowController({ preferences, rendererDevUrl }: MiniWindowDeps): MiniWindowController {
  let window: BrowserWindow | null = null;
  let quitting = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(open: boolean) => void>();
  const announce = (open: boolean) => {
    for (const listener of listeners) listener(open);
  };

  // Quitting closes this window too, but it should come back next launch, so that close is not
  // recorded as the user closing it.
  app.on('before-quit', () => {
    quitting = true;
  });

  const saveBounds = () => {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      if (!window || window.isDestroyed()) return;
      void preferences.update({ miniBounds: window.getBounds() });
    }, BOUNDS_SAVE_DELAY_MS);
  };

  const create = (): BrowserWindow => {
    const workAreas = screen.getAllDisplays().map(display => display.workArea);
    const bounds = restoreBounds(preferences.current().miniBounds, workAreas);
    const created = new BrowserWindow({
      ...(bounds ?? MINI_DEFAULT_SIZE),
      minWidth: MINI_MIN_SIZE.width,
      minHeight: MINI_MIN_SIZE.height,
      show: false,
      frame: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hiddenInMissionControl: true,
      alwaysOnTop: true,
      title: 'Mini Tavern',
      webPreferences: {
        preload: join(__dirname, '../preload/mini.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    markCompanionWindow(created);
    // 'floating' sits above normal windows without covering menus and alerts.
    created.setAlwaysOnTop(true, 'floating');
    // skipTransformProcessType keeps macOS from briefly hiding the dock icon to do this.
    created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    // The shared renderer's <title> would otherwise rename this window to the app's name.
    created.on('page-title-updated', event => event.preventDefault());
    // No remote content, ever: links leave for the browser and the window never navigates.
    created.webContents.setWindowOpenHandler(({ url }) => {
      if (isExternallyOpenable(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    created.webContents.on('will-navigate', (event, url) => {
      if (url === created.webContents.getURL()) return;
      event.preventDefault();
    });
    created.on('moved', saveBounds);
    created.on('resized', saveBounds);
    created.on('closed', () => {
      if (window === created) window = null;
      if (!quitting) void preferences.update({ miniOpen: false });
      announce(false);
    });
    created.once('ready-to-show', () => created.showInactive());

    if (rendererDevUrl) void created.loadURL(`${rendererDevUrl}#/${ROUTE}`);
    else void created.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/${ROUTE}` });
    return created;
  };

  const isOpen = () => window !== null && !window.isDestroyed();

  const controller: MiniWindowController = {
    show() {
      if (isOpen()) {
        window?.showInactive();
        return;
      }
      window = create();
      void preferences.update({ miniOpen: true });
      announce(true);
    },
    hide() {
      if (isOpen()) window?.close();
    },
    toggle() {
      if (isOpen()) controller.hide();
      else controller.show();
    },
    isOpen,
    owns(sender) {
      return isOpen() && window?.webContents === sender;
    },
    push(snapshot) {
      if (isOpen()) window?.webContents.send(IPC_CHANNELS.watchSnapshot, snapshot);
    },
    onVisibilityChanged(listener) {
      listeners.add(listener);
    },
  };
  return controller;
}

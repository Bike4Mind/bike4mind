import { join } from 'node:path';
import { BrowserWindow, screen, shell, type Rectangle, type WebContents } from 'electron';
import { isExternallyOpenable } from '@shared/externalLinks';
import { markCompanionWindow } from './windows';

export type WindowSize = { width: number; height: number };
export type WindowBounds = WindowSize & { x: number; y: number };

/** Moves and resizes arrive per frame while dragging; the file only needs the last one. */
export const BOUNDS_SAVE_DELAY_MS = 400;

/**
 * Saved bounds, moved fully onto the screen they overlap most. A window saved on an unplugged
 * display, or under a menu bar or dock that has since grown, would otherwise reopen where its top
 * strip (the drag handle) cannot be reached; null, when it overlaps no screen, means "use the default".
 */
export function restoreBounds(
  saved: WindowBounds | null,
  workAreas: readonly Rectangle[],
  minSize: WindowSize
): WindowBounds | null {
  if (!saved) return null;
  let best: Rectangle | null = null;
  let bestOverlap = 0;
  for (const area of workAreas) {
    const overlapX = Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x);
    const overlapY = Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y);
    const overlap = overlapX > 0 && overlapY > 0 ? overlapX * overlapY : 0;
    if (overlap > bestOverlap) {
      best = area;
      bestOverlap = overlap;
    }
  }
  if (!best) return null;
  const width = clamp(saved.width, minSize.width, best.width);
  const height = clamp(saved.height, minSize.height, best.height);
  return {
    x: clamp(saved.x, best.x, best.x + best.width - width),
    y: clamp(saved.y, best.y, best.y + best.height - height),
    width,
    height,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export interface FloatingWindowController {
  show(): void;
  hide(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Whether an IPC call came from this window: its surface answers nobody else. */
  owns(sender: WebContents): boolean;
  /** A push to the window's page; dropped while it is closed. */
  send(channel: string, payload: unknown): void;
  onVisibilityChanged(listener: (open: boolean) => void): void;
}

/** Where a floating window keeps its bounds and whether it was open at quit. */
export interface FloatingWindowMemory {
  bounds(): WindowBounds | null;
  saveBounds(bounds: WindowBounds): void;
  saveOpen(open: boolean): void;
}

export type FloatingWindowOptions = {
  title: string;
  /** The renderer route it shows; hash history, so it works over file:// too. */
  route: string;
  /** The preload bundle's file name beside the app's own, e.g. 'mini.js'. Each is a narrow bridge. */
  preload: string;
  defaultSize: WindowSize;
  minSize: WindowSize;
  memory: FloatingWindowMemory;
  /**
   * The app is past its quit confirmation and closing everything. A close then is not the user
   * closing the window, so it reopens next launch. A quit the user cancels never gets here.
   */
  isQuitting(): boolean;
  /** electron-vite's dev server; absent in a packaged build, which loads the renderer off disk. */
  rendererDevUrl?: string;
};

/**
 * A small frameless window that floats over other apps, on every Space and over full-screen apps, and
 * remembers where it was and whether it was open: the mini Tavern (main/watch) and the Orchestrate mini
 * window (main/orchestrateMini). Each loads the shared renderer on its own route behind its own preload,
 * with the main window's sandbox and isolation, and counts as a companion (windows.ts), so it never
 * keeps the app alive or receives app broadcasts.
 */
export function createFloatingWindowController(options: FloatingWindowOptions): FloatingWindowController {
  const { memory, isQuitting, rendererDevUrl } = options;
  let window: BrowserWindow | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(open: boolean) => void>();
  const announce = (open: boolean) => {
    for (const listener of listeners) listener(open);
  };

  const saveBounds = () => {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      if (!window || window.isDestroyed()) return;
      memory.saveBounds(window.getBounds());
    }, BOUNDS_SAVE_DELAY_MS);
  };

  const create = (): BrowserWindow => {
    const workAreas = screen.getAllDisplays().map(display => display.workArea);
    const bounds = restoreBounds(memory.bounds(), workAreas, options.minSize);
    const created = new BrowserWindow({
      ...(bounds ?? options.defaultSize),
      minWidth: options.minSize.width,
      minHeight: options.minSize.height,
      show: false,
      frame: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hiddenInMissionControl: true,
      alwaysOnTop: true,
      title: options.title,
      webPreferences: {
        preload: join(__dirname, '../preload', options.preload),
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
    // 'moved'/'resized' fire only at the end of a user drag on macOS, not for a resize by the system
    // or another app, so the debounced continuous events are the ones that never miss.
    created.on('move', saveBounds);
    created.on('resize', saveBounds);
    created.on('close', () => {
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      saveTimer = undefined;
      memory.saveBounds(created.getBounds());
    });
    created.on('closed', () => {
      if (window === created) window = null;
      if (!isQuitting()) memory.saveOpen(false);
      announce(false);
    });
    created.once('ready-to-show', () => created.showInactive());

    if (rendererDevUrl) void created.loadURL(`${rendererDevUrl}#/${options.route}`);
    else void created.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/${options.route}` });
    return created;
  };

  const isOpen = () => window !== null && !window.isDestroyed();

  const controller: FloatingWindowController = {
    show() {
      if (isOpen()) {
        window?.showInactive();
        return;
      }
      window = create();
      memory.saveOpen(true);
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
    send(channel, payload) {
      if (isOpen()) window?.webContents.send(channel, payload);
    },
    onVisibilityChanged(listener) {
      listeners.add(listener);
    },
  };
  return controller;
}

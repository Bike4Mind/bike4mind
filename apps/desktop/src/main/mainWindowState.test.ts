import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAIN_WINDOW_PREFERENCES,
  initialMainWindowPlacement,
  MAIN_WINDOW_DEFAULT_SIZE,
  MAIN_WINDOW_SAVE_DELAY_MS,
  MainWindowStateStore,
  parseMainWindowPreferences,
  trackMainWindowState,
} from './mainWindowState';
import type { WindowBounds } from './windowBounds';

const laptop: WindowBounds = { x: 0, y: 25, width: 1512, height: 920 };
const monitor: WindowBounds = { x: 1512, y: 0, width: 2560, height: 1415 };

async function storeFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'main-window-')), 'main-window.json');
}

describe('parseMainWindowPreferences', () => {
  it('falls back field by field', () => {
    expect(parseMainWindowPreferences(undefined)).toEqual(DEFAULT_MAIN_WINDOW_PREFERENCES);
    expect(parseMainWindowPreferences({ bounds: { x: 'a' }, maximized: true })).toEqual({
      bounds: null,
      maximized: true,
    });
    expect(parseMainWindowPreferences({ bounds: { x: 10, y: 20, width: 800, height: 600 }, maximized: 'yes' })).toEqual(
      {
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        maximized: false,
      }
    );
  });
});

describe('initialMainWindowPlacement', () => {
  it('opens at the default size, centred, with nothing saved', () => {
    expect(initialMainWindowPlacement(DEFAULT_MAIN_WINDOW_PREFERENCES, [laptop])).toEqual({
      bounds: MAIN_WINDOW_DEFAULT_SIZE,
      maximized: false,
    });
  });

  it('restores saved bounds that are still on a connected display', () => {
    const bounds = { x: 1700, y: 100, width: 1400, height: 900 };
    expect(initialMainWindowPlacement({ bounds, maximized: true }, [laptop, monitor])).toEqual({
      bounds,
      maximized: true,
    });
  });

  it('falls back to the default when the display it was saved on is unplugged', () => {
    const onMonitor = { x: 1700, y: 100, width: 1400, height: 900 };
    expect(initialMainWindowPlacement({ bounds: onMonitor, maximized: false }, [laptop])).toEqual({
      bounds: MAIN_WINDOW_DEFAULT_SIZE,
      maximized: false,
    });
  });

  it('pulls a window hanging off a display fully back onto it and shrinks it to fit', () => {
    const straddling = { x: 1200, y: -40, width: 2000, height: 1200 };
    expect(initialMainWindowPlacement({ bounds: straddling, maximized: false }, [laptop]).bounds).toEqual({
      x: 0,
      y: 25,
      width: 1512,
      height: 920,
    });
  });
});

class FakeWindow extends EventEmitter {
  normalBounds: WindowBounds = { x: 10, y: 30, width: 900, height: 700 };
  maximized = false;
  fullScreen = false;
  destroyed = false;
  getNormalBounds = () => this.normalBounds;
  isMaximized = () => this.maximized;
  isFullScreen = () => this.fullScreen;
  isDestroyed = () => this.destroyed;
}

describe('trackMainWindowState', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves the last bounds of a drag once, after it settles', async () => {
    vi.useFakeTimers();
    const store = new MainWindowStateStore(await storeFile());
    const update = vi.spyOn(store, 'update');
    const window = new FakeWindow();
    trackMainWindowState(window, store);

    window.emit('move');
    window.normalBounds = { x: 50, y: 60, width: 900, height: 700 };
    window.emit('resize');
    expect(update).not.toHaveBeenCalled();

    vi.advanceTimersByTime(MAIN_WINDOW_SAVE_DELAY_MS);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ bounds: { x: 50, y: 60, width: 900, height: 700 }, maximized: false });
  });

  it('records maximising straight away, keeping the un-maximised bounds', async () => {
    const store = new MainWindowStateStore(await storeFile());
    const window = new FakeWindow();
    trackMainWindowState(window, store);

    window.maximized = true;
    window.emit('maximize');
    expect(store.current()).toEqual({ bounds: window.normalBounds, maximized: true });
  });

  it('saves on close, cancelling a pending debounced save, and the file reloads', async () => {
    vi.useFakeTimers();
    const path = await storeFile();
    const store = new MainWindowStateStore(path);
    const update = vi.spyOn(store, 'update');
    const window = new FakeWindow();
    trackMainWindowState(window, store);

    window.emit('resize');
    window.emit('close');
    vi.advanceTimersByTime(MAIN_WINDOW_SAVE_DELAY_MS * 2);
    expect(update).toHaveBeenCalledTimes(1);
    vi.useRealTimers();

    await update.mock.results[0]?.value;
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ bounds: window.normalBounds, maximized: false });
    expect(await new MainWindowStateStore(path).load()).toEqual({ bounds: window.normalBounds, maximized: false });
  });

  it('ignores changes while full screen', async () => {
    const store = new MainWindowStateStore(await storeFile());
    const update = vi.spyOn(store, 'update');
    const window = new FakeWindow();
    trackMainWindowState(window, store);

    window.fullScreen = true;
    window.emit('close');
    expect(update).not.toHaveBeenCalled();
  });
});

import type { BrowserWindow } from 'electron';
import { PreferenceFile } from './preferenceFile';
import { fitBoundsToDisplays, windowBoundsSchema, type WindowBounds, type WindowSize } from './windowBounds';

export const MAIN_WINDOW_DEFAULT_SIZE: WindowSize = { width: 1280, height: 860 };
/** The smallest a restored window is clamped to; below this the sidebar and composer collide. */
export const MAIN_WINDOW_RESTORE_MIN_SIZE: WindowSize = { width: 480, height: 360 };
/** Moves and resizes arrive per frame while dragging; the file only needs the last one. */
export const MAIN_WINDOW_SAVE_DELAY_MS = 400;

export type MainWindowPreferences = {
  /** The un-maximised bounds, so a maximised window restores to its own size when unmaximised. */
  bounds: WindowBounds | null;
  maximized: boolean;
};

export const DEFAULT_MAIN_WINDOW_PREFERENCES: MainWindowPreferences = { bounds: null, maximized: false };

/** Field by field, so one bad value (a hand edit, an older file) does not reset the other. */
export function parseMainWindowPreferences(value: unknown): MainWindowPreferences {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const bounds = windowBoundsSchema.safeParse(record.bounds);
  return {
    bounds: bounds.success ? bounds.data : null,
    maximized: typeof record.maximized === 'boolean' ? record.maximized : false,
  };
}

export class MainWindowStateStore extends PreferenceFile<MainWindowPreferences> {
  constructor(filePath: string) {
    super(filePath, parseMainWindowPreferences, 'MAIN WINDOW');
  }
}

export type MainWindowPlacement = {
  /** Without x and y, Electron centres the window on the primary display. */
  bounds: WindowSize | WindowBounds;
  maximized: boolean;
};

/** Where the main window opens: its saved place if a connected display still shows it. */
export function initialMainWindowPlacement(
  saved: MainWindowPreferences,
  workAreas: readonly WindowBounds[]
): MainWindowPlacement {
  const fitted = fitBoundsToDisplays(saved.bounds, workAreas, MAIN_WINDOW_RESTORE_MIN_SIZE);
  return { bounds: fitted ?? MAIN_WINDOW_DEFAULT_SIZE, maximized: saved.maximized };
}

type TrackedWindow = Pick<BrowserWindow, 'getNormalBounds' | 'isMaximized' | 'isFullScreen' | 'isDestroyed'> & {
  on(event: 'move' | 'resize' | 'maximize' | 'unmaximize' | 'close', listener: () => void): unknown;
};

/**
 * Record the window's bounds and maximised state as they change, debounced, and once more as it
 * closes so a quit straight after a drag is not lost. Full screen is a mode the user enters each
 * time, not a place, so it is neither saved nor allowed to overwrite the bounds underneath it.
 */
export function trackMainWindowState(window: TrackedWindow, store: MainWindowStateStore): void {
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const snapshot = (): Partial<MainWindowPreferences> | null => {
    if (window.isDestroyed() || window.isFullScreen()) return null;
    return { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
  };

  const saveNow = () => {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = undefined;
    const patch = snapshot();
    if (patch) void store.update(patch);
  };

  const saveSoon = () => {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, MAIN_WINDOW_SAVE_DELAY_MS);
  };

  window.on('move', saveSoon);
  window.on('resize', saveSoon);
  window.on('maximize', saveNow);
  window.on('unmaximize', saveNow);
  window.on('close', saveNow);
}

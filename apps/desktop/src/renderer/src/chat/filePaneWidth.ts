import { browserPaneMaxWidth } from './browserPaneWidth';

/** Remembered per machine, like the other side panes: window chrome, not part of a conversation. */
const STORAGE_KEY = 'b4m.filePane.width';

export const FILE_PANE_WIDTH = 520;
/** Narrower than this and a line of code wraps on nearly every line. */
export const FILE_PANE_MIN_WIDTH = 320;

/** The same ceiling as the browser pane: a share of the window, and never the conversation's minimum. */
export const filePaneMaxWidth = browserPaneMaxWidth;

/** The maximum wins over the minimum, so a window too small for both still lays out. */
export function clampFilePaneWidth(width: number, max = Number.POSITIVE_INFINITY): number {
  const wanted = Number.isFinite(width) ? Math.round(width) : FILE_PANE_WIDTH;
  return Math.min(max, Math.max(FILE_PANE_MIN_WIDTH, wanted));
}

export function readFilePaneWidth(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? FILE_PANE_WIDTH : clampFilePaneWidth(Number(raw));
  } catch {
    // Storage blocked: the default for this run.
    return FILE_PANE_WIDTH;
  }
}

export function writeFilePaneWidth(width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clampFilePaneWidth(width)));
  } catch {
    // Kept for this run; losing it next launch beats throwing out of a drag.
  }
}

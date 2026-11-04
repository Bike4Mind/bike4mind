import { browserPaneMaxWidth } from '../browserPaneWidth';

/** Remembered per machine, like the browser pane: window chrome, not part of a conversation. */
const STORAGE_KEY = 'b4m.modelPane.width';

export const MODEL_PANE_WIDTH = 420;
/** Narrower than this and the header's buttons and the param labels start to crowd. */
export const MODEL_PANE_MIN_WIDTH = 320;

/** The same ceiling as the browser pane: a share of the window, and never the conversation's minimum. */
export const modelPaneMaxWidth = browserPaneMaxWidth;

/** The maximum wins over the minimum, so a window too small for both still lays out. */
export function clampModelPaneWidth(width: number, max = Number.POSITIVE_INFINITY): number {
  const wanted = Number.isFinite(width) ? Math.round(width) : MODEL_PANE_WIDTH;
  return Math.min(max, Math.max(MODEL_PANE_MIN_WIDTH, wanted));
}

export function readModelPaneWidth(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? MODEL_PANE_WIDTH : clampModelPaneWidth(Number(raw));
  } catch {
    // Storage blocked: the default for this run.
    return MODEL_PANE_WIDTH;
  }
}

export function writeModelPaneWidth(width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clampModelPaneWidth(width)));
  } catch {
    // Kept for this run; losing it next launch beats throwing out of a drag.
  }
}

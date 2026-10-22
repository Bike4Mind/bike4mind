import { BROWSER_PANE_MAX_FRACTION, BROWSER_PANE_WIDTH } from './agentBrowser';

/**
 * How wide the user has dragged the agent's browser, remembered per machine and not per
 * conversation - window chrome, with the same storage reasoning and blocked-storage fallback as
 * sidebarWidth.ts.
 */
const STORAGE_KEY = 'b4m.browserPane.width';

/** Narrower than this and most sites are already deep in their phone layout; see BROWSER_PANE_WIDTH. */
export const BROWSER_PANE_MIN_WIDTH = 320;

/**
 * What a drag may never take from the conversation: enough for the composer's controls to sit on
 * one row and for a reply to read as prose rather than a column of single words.
 */
export const CONVERSATION_MIN_WIDTH = 400;

/**
 * The widest the pane may be in the current layout.
 *
 * `shared` is the width the pane and the conversation split between them: the window less the
 * fixed columns (sidebar, background tasks) whatever those are at the moment. The conversation
 * keeps CONVERSATION_MIN_WIDTH of it, but never at the cost of the pane going under its own
 * minimum - when the two cannot both fit, the window fraction is what still holds.
 */
export function browserPaneMaxWidth(viewport: number, shared: number): number {
  const byFraction = Math.floor(viewport * BROWSER_PANE_MAX_FRACTION);
  const byConversation = Math.max(BROWSER_PANE_MIN_WIDTH, Math.floor(shared - CONVERSATION_MIN_WIDTH));
  return Math.max(0, Math.min(byFraction, byConversation));
}

/** The maximum wins over the minimum, so a window too small for both still lays out. */
export function clampBrowserPaneWidth(width: number, max = Number.POSITIVE_INFINITY): number {
  const wanted = Number.isFinite(width) ? Math.round(width) : BROWSER_PANE_WIDTH;
  return Math.min(max, Math.max(BROWSER_PANE_MIN_WIDTH, wanted));
}

/** Clamped only to the minimum: the maximum is the window's, and the window can be bigger next launch. */
export function readBrowserPaneWidth(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? BROWSER_PANE_WIDTH : clampBrowserPaneWidth(Number(raw));
  } catch {
    // Storage blocked. The default for this run, which is what it would have been anyway.
    return BROWSER_PANE_WIDTH;
  }
}

export function writeBrowserPaneWidth(width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clampBrowserPaneWidth(width)));
  } catch {
    // Kept for this run; losing it on the next launch beats throwing out of a drag.
  }
}

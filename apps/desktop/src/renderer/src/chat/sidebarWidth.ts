/**
 * How wide the user has dragged the sidebar, remembered per machine.
 *
 * Window chrome rather than anything about a conversation, so localStorage and not the session
 * file - the same reasoning, and the same blocked-storage fallback, as the task panel flags in
 * backgroundTasks.ts.
 */
const STORAGE_KEY = 'b4m.sidebar.width';

/** What the sidebar is until someone drags it. */
export const SIDEBAR_DEFAULT_WIDTH = 280;

/**
 * Narrow enough to give the transcript most of a small window, wide enough that a session title
 * still has ~150px left after the row's insets and the fade over its last 24px - under that the
 * list stops being scannable and the search box starts wrapping its placeholder.
 */
export const SIDEBAR_MIN_WIDTH = 200;

/**
 * The transcript's reading column is 760px, and a 1280px window has to be able to hold one
 * beside the sidebar. Past this the sidebar is taking width the column cannot give back.
 */
export const SIDEBAR_MAX_WIDTH = 480;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

/** Clamped on the way out as well as in: the bounds can move between releases, the stored value cannot. */
export function readSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? SIDEBAR_DEFAULT_WIDTH : clampSidebarWidth(Number(raw));
  } catch {
    // Storage blocked. The default for this run, which is what it would have been anyway.
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function writeSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clampSidebarWidth(width)));
  } catch {
    // Kept for this run; losing it on the next launch beats throwing out of a drag.
  }
}

/**
 * The agent browser's tabs, as both processes speak of them.
 *
 * The shortcuts are read in two places: the renderer hears them while focus is in the pane's own
 * chrome, and main hears them through `before-input-event` while focus is inside the page,
 * which the renderer never sees a key from. One table keeps the two from drifting apart.
 */

/** Per conversation. Past it a popup opens in the tab that asked, and the pane's "+" is disabled. */
export const MAX_BROWSER_TABS = 10;

export type BrowserTabShortcut = 'new' | 'close' | 'previous' | 'next';

export interface TabShortcutKey {
  /** `KeyboardEvent.code`, which names the key rather than what Shift turned it into. */
  code: string;
  shift: boolean;
  alt: boolean;
  /** Cmd on macOS, Ctrl elsewhere. */
  primary: boolean;
}

export function browserTabShortcut(key: TabShortcutKey): BrowserTabShortcut | null {
  if (!key.primary || key.alt) return null;
  if (!key.shift && key.code === 'KeyT') return 'new';
  if (!key.shift && key.code === 'KeyW') return 'close';
  if (key.shift && key.code === 'BracketLeft') return 'previous';
  if (key.shift && key.code === 'BracketRight') return 'next';
  return null;
}

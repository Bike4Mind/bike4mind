/**
 * The terminal panel's window chrome: which conversations have it open, and how tall it is.
 *
 * Open is remembered PER CONVERSATION, unlike the browser's single flag: an open panel starts a
 * shell, and a flag that followed the user from conversation to conversation would start one in
 * every conversation they clicked through. Height is per machine, like every other panel size.
 * Same blocked-storage fallback as agentBrowser.ts.
 */
const OPEN_KEY = 'b4m.terminalPanel.openSessions';
const HEIGHT_KEY = 'b4m.terminalPanel.height';

/** Conversations whose open panel is remembered; the oldest fall off. */
const MAX_REMEMBERED_OPEN = 100;

export const TERMINAL_PANEL_HEIGHT = 280;
export const TERMINAL_PANEL_MIN_HEIGHT = 120;

/** What a drag may never take from the header, thread and composer above the panel. */
export const CONVERSATION_MIN_HEIGHT = 320;

/** Lines the renderer keeps per terminal. Main retains output on its own for a late attach. */
export const TERMINAL_SCROLLBACK = 5_000;

export function readTerminalOpenSessions(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(OPEN_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Most recent first. Returns the new list so the caller's state and storage stay one value. */
export function withTerminalOpen(current: readonly string[], sessionId: string, open: boolean): string[] {
  const rest = current.filter(id => id !== sessionId);
  return (open ? [sessionId, ...rest] : rest).slice(0, MAX_REMEMBERED_OPEN);
}

export function writeTerminalOpenSessions(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(OPEN_KEY, JSON.stringify(ids));
  } catch {
    // Kept for this run.
  }
}

/** The maximum wins over the minimum, so a window too short for both still lays out. */
export function clampTerminalPanelHeight(height: number, max = Number.POSITIVE_INFINITY): number {
  const wanted = Number.isFinite(height) ? Math.round(height) : TERMINAL_PANEL_HEIGHT;
  return Math.max(0, Math.min(max, Math.max(TERMINAL_PANEL_MIN_HEIGHT, wanted)));
}

/** `column` is the conversation column the panel shares its height with, panel included. */
export function terminalPanelMaxHeight(column: number): number {
  return Math.max(TERMINAL_PANEL_MIN_HEIGHT, Math.floor(column - CONVERSATION_MIN_HEIGHT));
}

export function readTerminalPanelHeight(): number {
  try {
    const raw = window.localStorage.getItem(HEIGHT_KEY);
    return raw === null ? TERMINAL_PANEL_HEIGHT : clampTerminalPanelHeight(Number(raw));
  } catch {
    return TERMINAL_PANEL_HEIGHT;
  }
}

export function writeTerminalPanelHeight(height: number): void {
  try {
    window.localStorage.setItem(HEIGHT_KEY, String(clampTerminalPanelHeight(height)));
  } catch {
    // Kept for this run.
  }
}

/**
 * Ctrl+` on every platform, as in VS Code. Not Cmd: Cmd+` is macOS's own window cycling.
 * Checked by `code` so it is the key left of 1 whatever the layout prints on it.
 */
export function isTerminalToggle(event: {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return event.code === 'Backquote' && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

import type { Input } from 'electron';

/** Only the parts of Electron's `Input` the chord test reads. */
export type ChordInput = Pick<Input, 'type' | 'code' | 'control' | 'meta' | 'alt' | 'shift'>;

/** What to tell the user it is. */
export const DEV_LOG_CHORD_LABEL = process.platform === 'darwin' ? 'Cmd+Alt+L' : 'Ctrl+Alt+L';

/**
 * Cmd+Alt+L on macOS, Ctrl+Alt+L elsewhere.
 *
 * `code` rather than `key`: Option plus a letter produces a symbol on macOS, so `key` here is
 * not 'l' - the same reason the sidebar's numbered jumps read `code` too.
 *
 * Alt is REQUIRED, and that is what keeps this clear of everything already bound. The app's own
 * Cmd/Ctrl bindings (the sidebar toggle, the numbered session jumps) all bail the moment Alt is
 * held; Chromium's built-in window shortcuts on this chord are the devtools trio (Cmd+Alt+I, J
 * and C) and reload (Cmd+R, Cmd+Shift+R); the default Electron menu's roles are Cmd+Q, W, M, H,
 * A, C, V, X, Z and Cmd+Shift+Z. macOS reserves Cmd+Opt+Esc, Cmd+Opt+D and Ctrl+Cmd+F, none of
 * which is this.
 */
export function isDevLogChord(input: ChordInput): boolean {
  if (input.type !== 'keyDown' || input.code !== 'KeyL') return false;
  if (!input.alt || input.shift) return false;
  return process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
}

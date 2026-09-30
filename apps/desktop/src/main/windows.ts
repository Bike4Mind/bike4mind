import { BrowserWindow } from 'electron';

const agentBrowserWindows = new WeakSet<BrowserWindow>();

/** The agent's hidden browser windows are not app windows: see {@link appWindows}. */
export function markAgentBrowserWindow(window: BrowserWindow): void {
  agentBrowserWindows.add(window);
}

/**
 * The windows the user sees. `BrowserWindow.getAllWindows()` also returns the agent's hidden
 * browsers, which must not receive app IPC, keep "reopen from the dock" from firing, or keep
 * the app alive after its last real window closes.
 */
export function appWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(window => !agentBrowserWindows.has(window));
}

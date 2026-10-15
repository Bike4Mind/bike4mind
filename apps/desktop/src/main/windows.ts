import { BrowserWindow } from 'electron';

const agentBrowserWindows = new WeakSet<BrowserWindow>();
const developerWindows = new WeakSet<BrowserWindow>();

/** The agent's hidden browser windows are not app windows: see {@link appWindows}. */
export function markAgentBrowserWindow(window: BrowserWindow): void {
  agentBrowserWindows.add(window);
}

/** The developer log window is not an app window either, and for the same reasons. */
export function markDeveloperWindow(window: BrowserWindow): void {
  developerWindows.add(window);
}

/**
 * The windows the user sees. `BrowserWindow.getAllWindows()` also returns the agent's hidden
 * browsers and the developer log window, none of which must receive app IPC, keep "reopen from
 * the dock" from firing, or keep the app alive after its last real window closes.
 */
export function appWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    window => !agentBrowserWindows.has(window) && !developerWindows.has(window)
  );
}

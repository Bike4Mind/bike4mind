/**
 * Where the PR bar's GitHub links open: this conversation's built-in browser pane by default,
 * the system browser on a Cmd-click (Ctrl-click off macOS), and the system browser too when
 * there is no conversation to own a pane. The bar's #number link is the exception and always
 * opens the system browser.
 *
 * The pane is not signed in to GitHub unless the user imported cookies into it themselves;
 * nothing here copies any.
 */

export interface LinkClick {
  metaKey: boolean;
  ctrlKey: boolean;
}

/** Opens `url` in the conversation's pane. Absent where the bar has nowhere to show one. */
export type BuiltInBrowserOpener = (url: string) => void;

export interface PrLinkTargets {
  openExternal(url: string): Promise<void>;
  navigate(request: { sessionId: string; url: string }): Promise<unknown>;
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);

export const SYSTEM_BROWSER_HINT = `${isMac ? 'Cmd' : 'Ctrl'}-click to open in your system browser`;

/** The pane and the OS each take only web pages from here; GitHub never sends anything else. */
export function isBrowsableUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function wantsSystemBrowser(click: LinkClick | undefined): boolean {
  return !!click && (click.metaKey || click.ctrlKey);
}

/** For links that always leave the app, like the bar's #number. Refuses anything but http(s). */
export function openInSystemBrowser(url: string, targets: PrLinkTargets = defaultTargets()): void {
  if (isBrowsableUrl(url)) void targets.openExternal(url);
}

/** One PR bar link click. Refuses anything but http(s) outright. */
export function routePrLink(
  url: string,
  click: LinkClick | undefined,
  openBuiltIn: BuiltInBrowserOpener | undefined,
  targets: PrLinkTargets = defaultTargets()
): void {
  if (!isBrowsableUrl(url)) return;
  if (!openBuiltIn || wantsSystemBrowser(click)) {
    void targets.openExternal(url);
    return;
  }
  openBuiltIn(url);
}

/**
 * Show `sessionId`'s pane and send it to `url`. The pane is shown first because navigate
 * resolves only once the page has loaded; the page is the session's one view, so a second
 * click reuses it. A refused navigation falls back to the system browser.
 */
export function openInSessionBrowser(
  url: string,
  sessionId: string | null,
  showPane: () => void,
  targets: PrLinkTargets = defaultTargets()
): void {
  if (!isBrowsableUrl(url)) return;
  if (!sessionId) {
    void targets.openExternal(url);
    return;
  }
  showPane();
  void targets.navigate({ sessionId, url }).catch(() => targets.openExternal(url));
}

function defaultTargets(): PrLinkTargets {
  return {
    openExternal: url => window.b4m.shell.openExternal(url),
    navigate: request => window.b4m.browser.navigate(request),
  };
}

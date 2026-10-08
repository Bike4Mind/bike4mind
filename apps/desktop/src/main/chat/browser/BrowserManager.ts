import {
  BrowserWindow,
  WebContentsView,
  session as electronSession,
  type BaseWindow,
  type Session,
  type WebContents,
} from 'electron';
import type { CookieImportState } from '@shared/browserCookies';
import type { ChatMedia } from '@shared/chat';
import { normalizeUrl } from '@shared/browserUrl';
import type { BrowserGoAction, BrowserPaneBounds, BrowserPaneState } from '@shared/ipc';
import { markAgentBrowserWindow } from '../../windows';
import type { BrowserContext, BrowserPage, BrowserProvider } from '../tools/types';
import { CookieImporter } from './cookies/CookieImporter';
import { CLICK_REF, FILL_REF, pageCall, SNAPSHOT_PAGE, type ElementOutcome, type SnapshotResult } from './pageScripts';

/**
 * One cookie jar for every conversation's browser, kept apart from anything the user browses:
 * signing in to a dev server once lasts across conversations and restarts, and none of the
 * user's real sessions are reachable from it.
 *
 * The one exception is an import the USER asks for, per site, from the pane's own menu - see
 * cookies/CookieImporter. Those go in as session cookies, so what this partition persists is
 * still only what the agent signed in to itself.
 */
const PARTITION = 'persist:b4m-agent-browser';
const VIEWPORT = { width: 1280, height: 800 };
const NAVIGATION_TIMEOUT_MS = 30_000;
/** How long a page script (snapshot, click, fill, evaluate) may take before the load holding it is stopped. */
const SCRIPT_TIMEOUT_MS = 15_000;
/** A user's own `browser_evaluate` may await real work, such as an API call, so it gets longer. */
const EVALUATE_TIMEOUT_MS = 30_000;
/** How long a script held by a load gets to run once that load is stopped. Measured at under 10ms. */
const STOP_RELEASE_MS = 2_000;
const CAPTURE_TIMEOUT_MS = 15_000;
/** Network idle has to hold this long to count; a SPA fires its next request right after load. */
const QUIET_MS = 400;
const MAX_BUFFERED_EVENTS = 200;

type ConsoleArgs = [unknown, ...unknown[]];

const TIMED_OUT = Symbol('timed out');

/** `work`, or TIMED_OUT once `ms` pass first. `work` keeps running; nothing stops it here. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} seconds`;

/** Whether a page has been anywhere yet. A blank one would paint white over the pane's empty state. */
function hasContent(url: string): boolean {
  return url !== '' && url !== 'about:blank';
}

/** Electron 35+ passes one details object; older builds passed positional arguments. */
function consoleEntry(args: ConsoleArgs): { level: string; message: string; source?: string } | null {
  const [first, ...rest] = args;
  const details = first as { level?: unknown; message?: unknown; sourceId?: unknown; lineNumber?: unknown };
  if (typeof details?.message === 'string') {
    return {
      level: String(details.level),
      message: details.message,
      source:
        typeof details.sourceId === 'string' ? `${details.sourceId}:${String(details.lineNumber ?? '')}` : undefined,
    };
  }
  if (typeof rest[0] === 'number' && typeof rest[1] === 'string') {
    const level = ['verbose', 'info', 'warning', 'error'][rest[0]] ?? 'info';
    return { level, message: rest[1], source: typeof rest[3] === 'string' ? rest[3] : undefined };
  }
  return null;
}

/**
 * One conversation's page, as a view that can be moved between windows.
 *
 * A `WebContentsView` rather than a window of its own, because that is the only thing Electron
 * can put INSIDE the app window as a pane. It is always the child of some window: the app
 * window while the user is looking at it, and otherwise the hidden one created alongside it.
 * That hidden window is what keeps a parked page composited, so `capturePage` still has
 * something to return - a view belonging to no window at all paints nothing.
 */
class ElectronPage implements BrowserPage {
  /** Where the view sits when it is not in the pane. Also the page's keep-alive; see above. */
  private readonly host: BrowserWindow;
  private readonly view: WebContentsView;
  private parent: BaseWindow;
  private readonly events: string[] = [];
  private lastStatus: number | undefined;
  private lastError = '';
  /** Main-frame navigations committed so far; tells a load that showed nothing from one that showed a page. */
  private commits = 0;
  inflight = 0;
  lastNetworkAt = 0;

  constructor(
    partition: Session,
    private readonly onClosed: () => void,
    private readonly onChanged: () => void
  ) {
    this.host = new BrowserWindow({
      show: false,
      ...VIEWPORT,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    markAgentBrowserWindow(this.host);
    this.view = new WebContentsView({
      webPreferences: {
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    this.host.contentView.addChildView(this.view);
    this.parent = this.host;
    this.view.setBounds({ x: 0, y: 0, ...VIEWPORT });

    const contents = this.view.webContents;
    contents.setAudioMuted(true);
    // A popup would be a window nobody can see; open it in this page instead.
    contents.setWindowOpenHandler(({ url }) => {
      void contents.loadURL(url).catch(() => undefined);
      return { action: 'deny' };
    });
    contents.on('did-navigate', (_event, url, status) => {
      this.commits += 1;
      this.lastStatus = status;
      this.lastError = '';
      this.record(`navigated to ${url}${status ? ` (HTTP ${status})` : ''}`);
      this.onChanged();
    });
    // A route change inside a SPA never fires did-navigate, and the pane still has to learn
    // that this page is now somewhere.
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) this.onChanged();
    });
    // The url bar's spinner and its enabled state, which nothing else would tell it about: a
    // reload moves neither the url nor the history.
    contents.on('did-start-loading', () => {
      this.lastError = '';
      this.onChanged();
    });
    contents.on('did-stop-loading', () => this.onChanged());
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED: a redirect or a client-side route change replacing the load, not a failure.
      if (!isMainFrame || code === -3) return;
      this.record(`failed to load ${url}: ${description}`);
      this.fail(`${url} could not be loaded: ${description}`);
    });
    contents.on('console-message', (...args: unknown[]) => {
      const entry = consoleEntry(args as ConsoleArgs);
      if (!entry || (entry.level !== 'error' && entry.level !== 'warning')) return;
      this.record(`console ${entry.level}: ${entry.message.slice(0, 500)}${entry.source ? ` (${entry.source})` : ''}`);
    });
    contents.on('render-process-gone', (_event, details) => {
      this.record(`the page crashed (${details.reason})`);
      this.fail(`The page crashed (${details.reason}).`);
    });
    contents.on('destroyed', () => this.onClosed());
  }

  get contentsId(): number {
    return this.view.webContents.id;
  }

  /** Say why nothing arrived, and tell the pane: a silent failure is a blank pane with no reason. */
  fail(reason: string): void {
    this.lastError = reason;
    this.onChanged();
  }

  record(line: string): void {
    this.events.push(line);
    if (this.events.length > MAX_BUFFERED_EVENTS) this.events.splice(0, this.events.length - MAX_BUFFERED_EVENTS);
  }

  private get contents(): WebContents {
    if (this.view.webContents.isDestroyed()) throw new Error('The browser was closed.');
    return this.view.webContents;
  }

  /** Whether this page is worth putting on screen. One that has been nowhere is not. */
  get showable(): boolean {
    return !this.view.webContents.isDestroyed() && hasContent(this.currentUrl());
  }

  /** Put the view in the app window at the pane's bounds, which are window-relative and in DIP. */
  showIn(window: BrowserWindow, bounds: BrowserPaneBounds): void {
    this.moveTo(window);
    this.view.setBounds(bounds);
  }

  /** Take the view back out of the app window, at the size every tool has always seen. */
  park(): void {
    this.moveTo(this.host);
    this.view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  }

  private moveTo(next: BaseWindow): void {
    if (this.parent === next || this.view.webContents.isDestroyed()) return;
    if (!this.parent.isDestroyed()) this.parent.contentView.removeChildView(this.view);
    next.contentView.addChildView(this.view);
    this.parent = next;
  }

  currentUrl(): string {
    return this.view.webContents.isDestroyed() ? '' : this.view.webContents.getURL();
  }

  /** What the pane's url bar draws. A destroyed page has nothing to say and no controls to offer. */
  state(): BrowserPaneState {
    const contents = this.view.webContents;
    if (contents.isDestroyed()) {
      return { url: '', canGoBack: false, canGoForward: false, loading: false, error: this.lastError };
    }
    return {
      url: hasContent(contents.getURL()) ? contents.getURL() : '',
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      loading: contents.isLoading(),
      error: this.lastError,
    };
  }

  /** Back, forward or reload, for the url bar. Doing neither of the first two is not an error. */
  go(action: BrowserGoAction): void {
    const history = this.contents.navigationHistory;
    if (action === 'reload') this.contents.reload();
    else if (action === 'back') history.goBack();
    else history.goForward();
  }

  async navigate(url: string): Promise<{ url: string; title: string; status?: number; stillLoading?: boolean }> {
    this.lastStatus = undefined;
    const commitsBefore = this.commits;
    let loaded: unknown;
    try {
      loaded = await within(this.contents.loadURL(url), NAVIGATION_TIMEOUT_MS);
    } catch (err) {
      // A redirect aborts the first load but still lands somewhere; only fail if it landed nowhere.
      if (!hasContent(this.currentUrl())) throw err;
    }
    if (loaded === TIMED_OUT) {
      // Stopped rather than left running: Electron holds every page script until the main frame
      // stops loading, so the snapshot after this would wait on it forever. See script().
      this.stop();
      if (this.commits === commitsBefore) {
        const still = hasContent(this.currentUrl()) ? `The browser is still on ${this.currentUrl()}.` : '';
        throw new Error(
          `${url} did not respond within ${seconds(NAVIGATION_TIMEOUT_MS)}, so loading was stopped. ${still}`.trim()
        );
      }
      return { url: this.currentUrl(), title: this.contents.getTitle(), status: this.lastStatus, stillLoading: true };
    }
    return { url: this.currentUrl(), title: this.contents.getTitle(), status: this.lastStatus };
  }

  stop(): void {
    if (!this.view.webContents.isDestroyed()) this.view.webContents.stop();
  }

  /**
   * Run a page script, bounded.
   *
   * Electron does not run executeJavaScript until the main frame stops loading, so one request
   * that never finishes would hold every snapshot and click forever. Past the deadline a load
   * still running is stopped, which releases the script at once; a script that still does not
   * answer is a renderer busy in its own code. An action given up on that way may still land if
   * the page recovers, which the error says.
   */
  private async script<T>(code: string, what: string, userGesture = false, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<T> {
    const contents = this.contents;
    const run = contents.executeJavaScript(code, userGesture) as Promise<T>;
    const first = await within(run, timeoutMs);
    if (first !== TIMED_OUT) return first;
    if (!contents.isDestroyed() && contents.isLoadingMainFrame()) {
      this.record(`stopped loading ${this.currentUrl()}: still loading after ${seconds(timeoutMs)}`);
      contents.stop();
      const released = await within(run, STOP_RELEASE_MS);
      if (released !== TIMED_OUT) return released;
    }
    throw new Error(
      `${what} did not finish within ${seconds(timeoutMs)}: the page is not responding, most likely busy ` +
        'running its own scripts. If this was an action it may still happen once the page recovers. ' +
        'Load the page again with browser_navigate, or try a different one.'
    );
  }

  async back(): Promise<void> {
    const history = this.contents.navigationHistory;
    if (!history.canGoBack()) throw new Error('There is no earlier page in this browser.');
    history.goBack();
  }

  async snapshot(maxChars: number): Promise<SnapshotResult> {
    return this.script<SnapshotResult>(pageCall(SNAPSHOT_PAGE, maxChars), 'Reading the page');
  }

  async click(ref: string): Promise<string> {
    const outcome = await this.script<ElementOutcome>(pageCall(CLICK_REF, ref), 'The click', true);
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.description;
  }

  async fill(ref: string, text: string): Promise<string> {
    const outcome = await this.script<ElementOutcome>(pageCall(FILL_REF, ref, text), 'Filling the field', true);
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.description;
  }

  async press(key: string): Promise<void> {
    const contents = this.contents;
    // A parked page holds no OS focus, so Enter would not reach a form: submit it directly.
    if (key === 'Enter') {
      const submitted = await this.script<boolean>(
        `(() => { const el = document.activeElement; const form = el && el.form; if (form && el.tagName !== 'TEXTAREA') { form.requestSubmit(); return true; } return false; })()`,
        'Pressing Enter'
      );
      if (submitted) return;
    }
    contents.focus();
    contents.sendInputEvent({ type: 'keyDown', keyCode: key });
    if (key.length === 1) contents.sendInputEvent({ type: 'char', keyCode: key });
    contents.sendInputEvent({ type: 'keyUp', keyCode: key });
  }

  async screenshot(): Promise<Buffer> {
    const image = await within(this.contents.capturePage(), CAPTURE_TIMEOUT_MS);
    if (image === TIMED_OUT) {
      throw new Error(
        `The page did not paint a frame to capture within ${seconds(CAPTURE_TIMEOUT_MS)}; it is not responding.`
      );
    }
    if (image.isEmpty()) throw new Error('The page rendered nothing to capture yet. Try again once it has loaded.');
    // A Retina capture is twice the viewport; the extra pixels only cost the model image tokens.
    const { width } = image.getSize();
    return (width > VIEWPORT.width ? image.resize({ width: VIEWPORT.width, quality: 'best' }) : image).toPNG();
  }

  async evaluate(expression: string): Promise<unknown> {
    let body: string;
    try {
      // Only parsed, never run here: it picks whether the input is one expression or statements.
      new Function(`return async () => (${expression});`);
      body = `return (${expression});`;
    } catch {
      body = expression;
    }
    const script =
      `(async () => { ${body} })().then(value => { try { return JSON.parse(JSON.stringify(value ?? null)); } ` +
      `catch { return String(value); } })`;
    return this.script<unknown>(script, 'The script', true, EVALUATE_TIMEOUT_MS);
  }

  drainEvents(): string[] {
    return this.events.splice(0, this.events.length);
  }

  async settle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.view.webContents.isDestroyed()) return;
      const quiet = this.inflight === 0 && Date.now() - this.lastNetworkAt >= QUIET_MS;
      if (!this.view.webContents.isLoading() && quiet) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async close(): Promise<void> {
    // Out of the app window first: destroying a view that is still a child of it would tear a
    // hole in the pane the renderer is drawing around.
    this.park();
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    if (!this.host.isDestroyed()) this.host.destroy();
  }
}

/** What the url bar draws for a conversation that has no browser, or no window to put one in. */
export const NO_PAGE: BrowserPaneState = {
  url: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  error: '',
};

/**
 * The agent's browser: one page per conversation, created on first use and closed with the
 * conversation or the app. Main-process only; tools reach it through {@link BrowserContext},
 * and the renderer reaches it through {@link setPane}.
 *
 * At most one page is on screen at a time. `pane` is the renderer's standing REQUEST - which
 * conversation, and where - and `apply` is what turns it into the one view that is currently a
 * child of the app window. Holding the request rather than acting on it once is what lets a
 * page that was blank when the pane opened appear by itself the moment the agent navigates it.
 */
export class BrowserManager implements BrowserProvider {
  private readonly pages = new Map<string, ElectronPage>();
  private readonly byContents = new Map<number, ElectronPage>();
  private partition: Session | undefined;
  private pane: { window: BrowserWindow; sessionId: string; bounds: BrowserPaneBounds } | undefined;
  private readonly watchedWindows = new WeakSet<BrowserWindow>();

  /**
   * The user's own Chrome sessions, for sites they named. Public because the renderer drives it
   * and nothing else does: it is reached from IPC handlers answering a click, never from a tool.
   */
  readonly cookies: CookieImporter;

  constructor(
    private readonly onPageState: (sessionId: string, state: BrowserPaneState) => void = () => undefined,
    onCookieState: (state: CookieImportState) => void = () => undefined
  ) {
    this.cookies = new CookieImporter(() => this.session(), onCookieState);
  }

  context(
    sessionId: string,
    keepScreenshot: (bytes: Buffer, caption: string) => Promise<ChatMedia | undefined>
  ): BrowserContext {
    return {
      page: async () => this.pageFor(sessionId),
      keepScreenshot,
      usesImportedCookies: url => this.cookies.usesImportedCookies(url),
    };
  }

  /**
   * Show one conversation's page in the app window, or show none.
   *
   * The renderer calls this on mount, on every resize, on every conversation switch and
   * whenever something has to be drawn over the pane, so it is cheap and idempotent. A request
   * WITH bounds is the only thing that opens a page, which is what keeps a browser from being
   * created for every conversation the user merely clicks on.
   */
  setPane(window: BrowserWindow, sessionId: string | null, bounds: BrowserPaneBounds | null): BrowserPaneState {
    if (!sessionId) {
      this.hidePane();
      return NO_PAGE;
    }
    if (!bounds) {
      this.hidePane();
      return this.pages.get(sessionId)?.state() ?? NO_PAGE;
    }
    const page = this.pageFor(sessionId);
    this.pane = { window, sessionId, bounds };
    this.watch(window);
    this.apply();
    return page.state();
  }

  /**
   * Open what the user typed in the url bar.
   *
   * Unlike the agent's `browser_navigate` there is no approval in front of this: the person
   * typing it is the person the approvals protect. The address is still resolved here rather
   * than trusted from the renderer, because the http/https rule is what keeps `file:` out of a
   * browser that bypasses every granted-roots check - and a failed load comes back as state the
   * bar can draw, not as a rejection it would have to translate.
   */
  async navigate(sessionId: string, url: string): Promise<BrowserPaneState> {
    const page = this.pageFor(sessionId);
    const resolved = normalizeUrl(url);
    try {
      await page.navigate(resolved);
    } catch (err) {
      page.fail(err instanceof Error ? err.message : String(err));
    }
    this.apply();
    return page.state();
  }

  /** Back, forward or reload. The resulting navigation arrives on its own as a state push. */
  go(sessionId: string, action: BrowserGoAction): BrowserPaneState {
    const page = this.pages.get(sessionId);
    if (!page) return NO_PAGE;
    page.go(action);
    return page.state();
  }

  async closeSession(sessionId: string): Promise<void> {
    if (this.pane?.sessionId === sessionId) this.pane = undefined;
    await this.pages.get(sessionId)?.close();
  }

  closeAll(): void {
    this.pane = undefined;
    for (const page of this.pages.values()) void page.close();
  }

  private hidePane(): void {
    this.pane = undefined;
    for (const page of this.pages.values()) page.park();
  }

  private apply(): void {
    const pane = this.pane;
    if (!pane) return;
    const page = this.pages.get(pane.sessionId);
    // Every other conversation's page goes back to its own window first, so switching
    // conversations can never leave the previous one's page over the new one's pane.
    for (const [id, other] of this.pages) if (id !== pane.sessionId) other.park();
    if (!page?.showable || pane.window.isDestroyed()) {
      page?.park();
      return;
    }
    page.showIn(pane.window, pane.bounds);
  }

  /**
   * A view still parented to a window being destroyed goes with it, taking the page the
   * conversation is in the middle of using. Closing the app window on macOS leaves the app
   * running, so the page has to outlive it.
   */
  private watch(window: BrowserWindow): void {
    if (this.watchedWindows.has(window)) return;
    this.watchedWindows.add(window);
    window.on('close', () => {
      if (this.pane?.window === window) this.hidePane();
    });
  }

  private pageFor(sessionId: string): ElectronPage {
    const existing = this.pages.get(sessionId);
    if (existing) return existing;
    const page: ElectronPage = new ElectronPage(
      this.session(),
      () => {
        this.pages.delete(sessionId);
        this.byContents.delete(page.contentsId);
        if (this.pane?.sessionId === sessionId) this.pane = undefined;
      },
      () => {
        this.onPageState(sessionId, page.state());
        this.apply();
      }
    );
    this.pages.set(sessionId, page);
    this.byContents.set(page.contentsId, page);
    return page;
  }

  /**
   * Hardened once: no permission prompts, no downloads, and the network listeners that feed each
   * page its failed requests. Electron allows one listener per webRequest event per session, so
   * they live here and route by webContents id.
   */
  private session(): Session {
    if (this.partition) return this.partition;
    const partition = electronSession.fromPartition(PARTITION);
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.setPermissionCheckHandler(() => false);
    partition.on('will-download', event => {
      event.preventDefault();
    });

    const pageOf = (id: number | undefined) => (id === undefined ? undefined : this.byContents.get(id));
    partition.webRequest.onBeforeRequest((details, callback) => {
      const page = pageOf(details.webContentsId);
      if (page) {
        page.inflight += 1;
        page.lastNetworkAt = Date.now();
      }
      callback({});
    });
    partition.webRequest.onCompleted(details => {
      const page = pageOf(details.webContentsId);
      if (!page) return;
      page.inflight = Math.max(0, page.inflight - 1);
      page.lastNetworkAt = Date.now();
      if (details.statusCode >= 400) page.record(`${details.method} ${details.url} -> HTTP ${details.statusCode}`);
    });
    partition.webRequest.onErrorOccurred(details => {
      const page = pageOf(details.webContentsId);
      if (!page) return;
      page.inflight = Math.max(0, page.inflight - 1);
      page.lastNetworkAt = Date.now();
      if (details.error !== 'net::ERR_ABORTED')
        page.record(`${details.method} ${details.url} failed: ${details.error}`);
    });
    this.partition = partition;
    return partition;
  }
}

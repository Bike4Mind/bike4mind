import {
  BrowserWindow,
  WebContentsView,
  session as electronSession,
  type BaseWindow,
  type Session,
  type WebContents,
} from 'electron';
import type { ChatMedia } from '@shared/chat';
import type { BrowserPaneBounds, BrowserPaneState } from '@shared/ipc';
import { markAgentBrowserWindow } from '../../windows';
import type { BrowserContext, BrowserPage, BrowserProvider } from '../tools/types';
import { CLICK_REF, FILL_REF, pageCall, SNAPSHOT_PAGE, type ElementOutcome, type SnapshotResult } from './pageScripts';

/**
 * One cookie jar for every conversation's browser, kept apart from anything the user browses:
 * signing in to a dev server once lasts across conversations and restarts, and none of the
 * user's real sessions are reachable from it.
 */
const PARTITION = 'persist:b4m-agent-browser';
const VIEWPORT = { width: 1280, height: 800 };
const NAVIGATION_TIMEOUT_MS = 30_000;
/** Network idle has to hold this long to count; a SPA fires its next request right after load. */
const QUIET_MS = 400;
const MAX_BUFFERED_EVENTS = 200;

type ConsoleArgs = [unknown, ...unknown[]];

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
  inflight = 0;
  lastNetworkAt = 0;

  constructor(
    partition: Session,
    private readonly onClosed: () => void,
    private readonly onNavigated: () => void
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
      this.lastStatus = status;
      this.record(`navigated to ${url}${status ? ` (HTTP ${status})` : ''}`);
      this.onNavigated();
    });
    // A route change inside a SPA never fires did-navigate, and the pane still has to learn
    // that this page is now somewhere.
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) this.onNavigated();
    });
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED: a redirect or a client-side route change replacing the load, not a failure.
      if (isMainFrame && code !== -3) this.record(`failed to load ${url}: ${description}`);
    });
    contents.on('console-message', (...args: unknown[]) => {
      const entry = consoleEntry(args as ConsoleArgs);
      if (!entry || (entry.level !== 'error' && entry.level !== 'warning')) return;
      this.record(`console ${entry.level}: ${entry.message.slice(0, 500)}${entry.source ? ` (${entry.source})` : ''}`);
    });
    contents.on('render-process-gone', (_event, details) => this.record(`the page crashed (${details.reason})`));
    contents.on('destroyed', () => this.onClosed());
  }

  get contentsId(): number {
    return this.view.webContents.id;
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

  async navigate(url: string): Promise<{ url: string; title: string; status?: number }> {
    this.lastStatus = undefined;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${url} did not finish loading in 30 seconds.`)),
        NAVIGATION_TIMEOUT_MS
      );
    });
    try {
      await Promise.race([this.contents.loadURL(url), timeout]);
    } catch (err) {
      // A redirect aborts the first load but still lands somewhere; only fail if it landed nowhere.
      if (!this.currentUrl() || this.currentUrl() === 'about:blank') throw err;
    } finally {
      clearTimeout(timer);
    }
    return { url: this.currentUrl(), title: this.contents.getTitle(), status: this.lastStatus };
  }

  async back(): Promise<void> {
    const history = this.contents.navigationHistory;
    if (!history.canGoBack()) throw new Error('There is no earlier page in this browser.');
    history.goBack();
  }

  async snapshot(maxChars: number): Promise<SnapshotResult> {
    return (await this.contents.executeJavaScript(pageCall(SNAPSHOT_PAGE, maxChars))) as SnapshotResult;
  }

  async click(ref: string): Promise<string> {
    const outcome = (await this.contents.executeJavaScript(pageCall(CLICK_REF, ref), true)) as ElementOutcome;
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.description;
  }

  async fill(ref: string, text: string): Promise<string> {
    const outcome = (await this.contents.executeJavaScript(pageCall(FILL_REF, ref, text), true)) as ElementOutcome;
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.description;
  }

  async press(key: string): Promise<void> {
    const contents = this.contents;
    // A parked page holds no OS focus, so Enter would not reach a form: submit it directly.
    if (key === 'Enter') {
      const submitted = (await contents.executeJavaScript(
        `(() => { const el = document.activeElement; const form = el && el.form; if (form && el.tagName !== 'TEXTAREA') { form.requestSubmit(); return true; } return false; })()`
      )) as boolean;
      if (submitted) return;
    }
    contents.focus();
    contents.sendInputEvent({ type: 'keyDown', keyCode: key });
    if (key.length === 1) contents.sendInputEvent({ type: 'char', keyCode: key });
    contents.sendInputEvent({ type: 'keyUp', keyCode: key });
  }

  async screenshot(): Promise<Buffer> {
    const image = await this.contents.capturePage();
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
    return this.contents.executeJavaScript(script, true);
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

  constructor(private readonly onPageUrl: (sessionId: string, url: string) => void = () => undefined) {}

  context(
    sessionId: string,
    keepScreenshot: (bytes: Buffer, caption: string) => Promise<ChatMedia | undefined>
  ): BrowserContext {
    return {
      page: async () => this.pageFor(sessionId),
      keepScreenshot,
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
      return { url: '' };
    }
    if (!bounds) {
      this.hidePane();
      return { url: this.pages.get(sessionId)?.currentUrl() ?? '' };
    }
    const page = this.pageFor(sessionId);
    this.pane = { window, sessionId, bounds };
    this.watch(window);
    this.apply();
    return { url: page.currentUrl() };
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
        this.onPageUrl(sessionId, page.currentUrl());
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

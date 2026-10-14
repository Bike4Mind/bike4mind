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
import { browserTabShortcut, MAX_BROWSER_TABS, type BrowserTabShortcut } from '@shared/browserTabs';
import { normalizeUrl } from '@shared/browserUrl';
import type {
  BrowserGoAction,
  BrowserPaneBounds,
  BrowserPaneState,
  BrowserTabAction,
  BrowserTabSummary,
} from '@shared/ipc';
import { markAgentBrowserWindow } from '../../windows';
import type { BrowserContext, BrowserPage, BrowserProvider, BrowserTabInfo } from '../tools/types';
import { CookieImporter } from './cookies/CookieImporter';
import {
  CLICK_REF,
  FILL_REF,
  pageCall,
  SCROLL_PAGE,
  SNAPSHOT_PAGE,
  type ElementOutcome,
  type ScrollTarget,
  type SnapshotResult,
} from './pageScripts';

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
/** A freeze-frame later than this is drawn after the hide it was for has usually ended. */
const STILL_TIMEOUT_MS = 1_000;
const STILL_JPEG_QUALITY = 80;
/** Network idle has to hold this long to count; a SPA fires its next request right after load. */
const QUIET_MS = 400;
const MAX_BUFFERED_EVENTS = 200;
/**
 * How long after an agent step a popup still counts as the agent's. Synthetic key events are
 * delivered asynchronously, so the popup a pressed Enter causes can arrive after press() returned.
 */
const AGENT_POPUP_GRACE_MS = 1_000;

type ConsoleArgs = [unknown, ...unknown[]];

/** The url bar's half of the pane state: one tab's. The manager adds the strip. */
type TabBarState = Omit<BrowserPaneState, 'tabs' | 'activeTabId'>;

interface TabHooks {
  onClosed: () => void;
  onChanged: () => void;
  /** A popup or `target=_blank` asked for `url`. `fromAgent` when one of the agent's own steps caused it. */
  onWindowOpen: (url: string, fromAgent: boolean, background: boolean) => void;
  onShortcut: (shortcut: BrowserTabShortcut) => void;
}

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
 * One tab of a conversation's browser, as a view that can be moved between windows.
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
  // Held from construction: Electron clears `view.webContents` once the contents are destroyed,
  // and 'destroyed' handlers and late tool calls still run after that.
  private readonly webContents: WebContents;
  readonly contentsId: number;
  private parent: BaseWindow;
  private readonly events: string[] = [];
  private lastStatus: number | undefined;
  private lastError = '';
  /** Main-frame navigations committed so far; tells a load that showed nothing from one that showed a page. */
  private commits = 0;
  /** Agent steps running in this page right now; a popup opened during one is the agent's. */
  private acting = 0;
  private actedAt = 0;
  inflight = 0;
  lastNetworkAt = 0;

  constructor(
    partition: Session,
    readonly id: number,
    private readonly hooks: TabHooks
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
        // Until it is the active tab; see setActive.
        backgroundThrottling: true,
      },
    });
    this.host.contentView.addChildView(this.view);
    this.parent = this.host;
    this.view.setBounds({ x: 0, y: 0, ...VIEWPORT });

    const contents = this.view.webContents;
    this.webContents = contents;
    this.contentsId = contents.id;
    contents.setAudioMuted(true);
    // A popup would be a window nobody can see, so it becomes a tab. Only http and https: main's
    // loadURL is not bound by the rules that stop a web page opening file: itself.
    contents.setWindowOpenHandler(({ url, disposition }) => {
      const fromAgent = this.acting > 0 || Date.now() - this.actedAt < AGENT_POPUP_GRACE_MS;
      if (/^https?:/i.test(url)) this.hooks.onWindowOpen(url, fromAgent, disposition === 'background-tab');
      else this.record(`blocked a popup to ${url.slice(0, 200)}: only http and https pages open in a tab`);
      return { action: 'deny' };
    });
    // Focus inside the page means the renderer hears none of these keys.
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const shortcut = browserTabShortcut({
        code: input.code,
        shift: input.shift,
        alt: input.alt,
        primary: process.platform === 'darwin' ? input.meta : input.control,
      });
      if (!shortcut) return;
      event.preventDefault();
      this.hooks.onShortcut(shortcut);
    });
    contents.on('did-navigate', (_event, url, status) => {
      this.commits += 1;
      this.lastStatus = status;
      this.lastError = '';
      this.record(`navigated to ${url}${status ? ` (HTTP ${status})` : ''}`);
      this.hooks.onChanged();
    });
    // A route change inside a SPA never fires did-navigate, and the pane still has to learn
    // that this page is now somewhere.
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) this.hooks.onChanged();
    });
    contents.on('page-title-updated', () => this.hooks.onChanged());
    // The url bar's spinner and its enabled state, which nothing else would tell it about: a
    // reload moves neither the url nor the history.
    contents.on('did-start-loading', () => {
      this.lastError = '';
      this.hooks.onChanged();
    });
    contents.on('did-stop-loading', () => this.hooks.onChanged());
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
    contents.on('destroyed', () => this.hooks.onClosed());
  }

  /** Say why nothing arrived, and tell the pane: a silent failure is a blank pane with no reason. */
  fail(reason: string): void {
    this.lastError = reason;
    this.hooks.onChanged();
  }

  /**
   * Only the active tab runs at full speed. It is unthrottled even while parked, because parked
   * is where the agent drives it from; an inactive one is throttled like a background tab in
   * Chrome, so ten open tabs cost about what one does.
   */
  setActive(active: boolean): void {
    if (!this.webContents.isDestroyed()) this.webContents.setBackgroundThrottling(!active);
  }

  record(line: string): void {
    this.events.push(line);
    if (this.events.length > MAX_BUFFERED_EVENTS) this.events.splice(0, this.events.length - MAX_BUFFERED_EVENTS);
  }

  private get contents(): WebContents {
    if (this.webContents.isDestroyed()) throw new Error('The browser was closed.');
    return this.webContents;
  }

  /** Whether this page is worth putting on screen. One that has been nowhere is not. */
  get showable(): boolean {
    return !this.webContents.isDestroyed() && hasContent(this.currentUrl());
  }

  /** Put the view in the app window at the pane's bounds, which are window-relative and in DIP. */
  showIn(window: BrowserWindow, bounds: BrowserPaneBounds): void {
    this.moveTo(window);
    this.view.setBounds(bounds);
    this.view.setVisible(true);
  }

  /**
   * Off screen but left in place, at the pane's size. Unlike parking, the page does not reflow
   * to the parked viewport and back for every menu, and {@link still} captures it as it looked.
   */
  hold(): void {
    this.view.setVisible(false);
  }

  /** Take the view back out of the app window, at the size every tool has always seen. */
  park(): void {
    this.view.setVisible(true);
    if (this.parent === this.host) return;
    this.moveTo(this.host);
    this.view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  }

  /** The held page as a JPEG data URL, or null when it painted nothing or took too long. */
  async still(): Promise<string | null> {
    if (this.webContents.isDestroyed()) return null;
    try {
      // `stayHidden`, or capturing would put the held view back on screen.
      const image = await within(this.webContents.capturePage(undefined, { stayHidden: true }), STILL_TIMEOUT_MS);
      if (image === TIMED_OUT || image.isEmpty()) return null;
      return `data:image/jpeg;base64,${image.toJPEG(STILL_JPEG_QUALITY).toString('base64')}`;
    } catch {
      return null;
    }
  }

  private moveTo(next: BaseWindow): void {
    if (this.parent === next || this.webContents.isDestroyed()) return;
    if (!this.parent.isDestroyed()) this.parent.contentView.removeChildView(this.view);
    next.contentView.addChildView(this.view);
    this.parent = next;
  }

  currentUrl(): string {
    return this.webContents.isDestroyed() ? '' : this.webContents.getURL();
  }

  title(): string {
    return this.webContents.isDestroyed() ? '' : this.webContents.getTitle();
  }

  summary(): BrowserTabSummary {
    const url = this.currentUrl();
    return {
      id: this.id,
      title: this.title(),
      url: hasContent(url) ? url : '',
      loading: !this.webContents.isDestroyed() && this.webContents.isLoading(),
    };
  }

  /** Load without waiting, for a tab opened from a popup: its failures arrive as state and events. */
  open(url: string): void {
    if (!this.webContents.isDestroyed()) void this.webContents.loadURL(url).catch(() => undefined);
  }

  /** What the pane's url bar draws. A destroyed page has nothing to say and no controls to offer. */
  state(): TabBarState {
    const contents = this.webContents;
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
    if (!this.webContents.isDestroyed()) this.webContents.stop();
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
    return this.asAgent(() => this.runScript<T>(code, what, userGesture, timeoutMs));
  }

  private async asAgent<T>(step: () => Promise<T>): Promise<T> {
    this.acting += 1;
    try {
      return await step();
    } finally {
      this.acting -= 1;
      this.actedAt = Date.now();
    }
  }

  private async runScript<T>(code: string, what: string, userGesture: boolean, timeoutMs: number): Promise<T> {
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

  async snapshot(maxChars: number, inView = false): Promise<SnapshotResult> {
    return this.script<SnapshotResult>(pageCall(SNAPSHOT_PAGE, maxChars, inView), 'Reading the page');
  }

  async scroll(target: ScrollTarget): Promise<string> {
    const outcome = await this.script<ElementOutcome>(pageCall(SCROLL_PAGE, target), 'Scrolling');
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.description;
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
    await this.asAgent(async () => {
      contents.focus();
      contents.sendInputEvent({ type: 'keyDown', keyCode: key });
      if (key.length === 1) contents.sendInputEvent({ type: 'char', keyCode: key });
      contents.sendInputEvent({ type: 'keyUp', keyCode: key });
    });
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
      if (this.webContents.isDestroyed()) return;
      const quiet = this.inflight === 0 && Date.now() - this.lastNetworkAt >= QUIET_MS;
      if (!this.webContents.isLoading() && quiet) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async close(): Promise<void> {
    // Out of the app window first: destroying a view that is still a child of it would tear a
    // hole in the pane the renderer is drawing around.
    this.park();
    if (!this.webContents.isDestroyed()) this.webContents.close();
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
  tabs: [],
  activeTabId: null,
};

/** One conversation's tabs. `active` is set exactly when `list` is not empty. */
interface SessionTabs {
  list: ElectronPage[];
  active: ElectronPage | undefined;
  /** Kept when every tab closes, so an id the agent was told about never names a different tab. */
  nextId: number;
}

/**
 * The agent's browser: an ordered list of tabs per conversation, created on first use and closed
 * with the conversation or the app. Main-process only; tools reach it through
 * {@link BrowserContext}, and the renderer reaches it through {@link setPane} and {@link tab}.
 *
 * Which tab is active lives here and nowhere else. The agent's tools act on it, the pane draws
 * it, and either side changing it is one push the other follows.
 *
 * At most one page is on screen at a time. `pane` is the renderer's standing REQUEST - which
 * conversation, and where - and `apply` is what turns it into the one view that is currently a
 * child of the app window. Holding the request rather than acting on it once is what lets a
 * page that was blank when the pane opened appear by itself the moment the agent navigates it.
 */
export class BrowserManager implements BrowserProvider {
  private readonly sessions = new Map<string, SessionTabs>();
  private readonly byContents = new Map<number, ElectronPage>();
  private partition: Session | undefined;
  /** `held` while the renderer has the page off screen for a moment; see {@link holdPane}. */
  private pane: { window: BrowserWindow; sessionId: string; bounds: BrowserPaneBounds; held: boolean } | undefined;
  /** The one tab that is a child of the app window, so apply never has to walk every conversation. */
  private shown: ElectronPage | undefined;
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
    const named = (id: number): ElectronPage => {
      const tab = this.sessions.get(sessionId)?.list.find(candidate => candidate.id === id);
      if (!tab) throw new Error(`There is no tab ${id}. browser_tabs with action "list" shows the open ones.`);
      return tab;
    };
    return {
      page: async () => this.activeTab(sessionId),
      tabs: () => this.tabInfo(sessionId),
      newTab: async () => this.openTab(sessionId, true) ?? null,
      selectTab: async id => {
        const tab = named(id);
        this.activate(sessionId, tab);
        return this.infoOf(sessionId, tab);
      },
      closeTab: async id => {
        const tab = named(id);
        const info = this.infoOf(sessionId, tab);
        await this.closeTab(sessionId, tab);
        return info;
      },
      keepScreenshot,
      usesImportedCookies: url => this.cookies.usesImportedCookies(url),
    };
  }

  /**
   * Show one conversation's active tab in the app window, or show none.
   *
   * The renderer calls this on mount, on every resize, on every conversation switch and
   * whenever something has to be drawn over the pane, so it is cheap and idempotent. It never
   * opens a tab: that waits for the url bar, the "+" or the agent, which is what keeps a browser
   * from being created for every conversation the user merely looks at - and what lets closing
   * the last tab leave the pane empty rather than reopening one on the next resize.
   */
  setPane(window: BrowserWindow, sessionId: string | null, bounds: BrowserPaneBounds | null): BrowserPaneState {
    if (!sessionId) {
      this.hidePane();
      return NO_PAGE;
    }
    if (!bounds) {
      this.holdPane(window, sessionId);
      return this.stateOf(sessionId);
    }
    this.pane = { window, sessionId, bounds, held: false };
    this.watch(window);
    this.apply();
    return this.stateOf(sessionId);
  }

  /**
   * A still of the page being held, for the pane to draw while it is off screen. Null when the
   * hold ended, or the tab changed, before the capture came back.
   */
  async freezeFrame(window: BrowserWindow, sessionId: string): Promise<string | null> {
    const page = this.shown;
    if (!page || !this.isHeld(window, sessionId)) return null;
    const still = await page.still();
    return this.shown === page && this.isHeld(window, sessionId) ? still : null;
  }

  /**
   * Open what the user typed in the url bar, in the active tab.
   *
   * Unlike the agent's `browser_navigate` there is no approval in front of this: the person
   * typing it is the person the approvals protect. The address is still resolved here rather
   * than trusted from the renderer, because the http/https rule is what keeps `file:` out of a
   * browser that bypasses every granted-roots check - and a failed load comes back as state the
   * bar can draw, not as a rejection it would have to translate.
   */
  async navigate(sessionId: string, url: string): Promise<BrowserPaneState> {
    const resolved = normalizeUrl(url);
    const page = this.activeTab(sessionId);
    try {
      await page.navigate(resolved);
    } catch (err) {
      page.fail(err instanceof Error ? err.message : String(err));
    }
    this.apply();
    return this.stateOf(sessionId);
  }

  /** Back, forward or reload. The resulting navigation arrives on its own as a state push. */
  go(sessionId: string, action: BrowserGoAction): BrowserPaneState {
    const page = this.sessions.get(sessionId)?.active;
    if (!page) return NO_PAGE;
    page.go(action);
    return this.stateOf(sessionId);
  }

  /** The tab strip. An id that is no longer open is ignored: the push that removed it is on its way. */
  async tab(sessionId: string, action: BrowserTabAction, tabId?: number): Promise<BrowserPaneState> {
    if (action === 'new') {
      this.openTab(sessionId, true);
      return this.stateOf(sessionId);
    }
    const tab = this.sessions.get(sessionId)?.list.find(candidate => candidate.id === tabId);
    if (tab && action === 'select') this.activate(sessionId, tab);
    if (tab && action === 'close') await this.closeTab(sessionId, tab);
    return this.stateOf(sessionId);
  }

  /**
   * The pane request is kept. Archiving closes the tabs of a conversation that stays on screen,
   * and the renderer only reports again when its bounds move, so dropping the request would
   * leave the next tab opened there invisible. For a deleted one it names nothing and is harmless.
   */
  async closeSession(sessionId: string): Promise<void> {
    const tabs = this.sessions.get(sessionId);
    // Gone before the tabs close, so each one's 'destroyed' finds nothing left to rearrange.
    this.sessions.delete(sessionId);
    if (!tabs) return;
    if (this.shown && tabs.list.includes(this.shown)) this.shown = undefined;
    await Promise.all(tabs.list.map(tab => tab.close()));
  }

  closeAll(): void {
    this.pane = undefined;
    this.shown = undefined;
    const all = [...this.sessions.values()].flatMap(tabs => tabs.list);
    this.sessions.clear();
    for (const tab of all) void tab.close();
  }

  private isHeld(window: BrowserWindow, sessionId: string): boolean {
    const pane = this.pane;
    return pane !== undefined && pane.held && pane.window === window && pane.sessionId === sessionId;
  }

  /**
   * Null bounds for the conversation already on screen - an overlay, a drag - keep the request
   * and hide the page where it is. For any other window or conversation there is nothing to
   * keep, and the page is parked as before.
   */
  private holdPane(window: BrowserWindow, sessionId: string): void {
    const pane = this.pane;
    if (!pane || pane.window !== window || pane.sessionId !== sessionId) {
      this.hidePane();
      return;
    }
    pane.held = true;
    this.apply();
  }

  private hidePane(): void {
    this.pane = undefined;
    this.shown?.park();
    this.shown = undefined;
  }

  private apply(): void {
    const pane = this.pane;
    const active = pane ? this.sessions.get(pane.sessionId)?.active : undefined;
    const next = pane && active?.showable && !pane.window.isDestroyed() ? active : undefined;
    // Parked first, so switching tabs or conversations can never leave the previous page over
    // the new one's pane.
    if (this.shown && this.shown !== next) this.shown.park();
    if (pane?.held) {
      // Nothing new goes up while held: a tab switched to now shows when the hold ends.
      if (this.shown !== next) this.shown = undefined;
      this.shown?.hold();
      return;
    }
    this.shown = next;
    if (next && pane) next.showIn(pane.window, pane.bounds);
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

  private stateOf(sessionId: string): BrowserPaneState {
    const tabs = this.sessions.get(sessionId);
    if (!tabs?.active) return NO_PAGE;
    return { ...tabs.active.state(), tabs: tabs.list.map(tab => tab.summary()), activeTabId: tabs.active.id };
  }

  private push(sessionId: string): void {
    this.onPageState(sessionId, this.stateOf(sessionId));
  }

  private tabInfo(sessionId: string): BrowserTabInfo[] {
    return this.sessions.get(sessionId)?.list.map(tab => this.infoOf(sessionId, tab)) ?? [];
  }

  private infoOf(sessionId: string, tab: ElectronPage): BrowserTabInfo {
    const { id, title, url } = tab.summary();
    return { id, title, url, active: this.sessions.get(sessionId)?.active === tab };
  }

  /** The tab every page tool acts on, opened if the conversation has none. */
  private activeTab(sessionId: string): ElectronPage {
    const active = this.sessions.get(sessionId)?.active;
    if (active) return active;
    // With no tab open there is nothing to count against the cap.
    return this.openTab(sessionId, true)!;
  }

  /** A new tab at the end of the strip, or undefined at the cap. */
  private openTab(sessionId: string, activate: boolean): ElectronPage | undefined {
    let tabs = this.sessions.get(sessionId);
    if (!tabs) {
      tabs = { list: [], active: undefined, nextId: 1 };
      this.sessions.set(sessionId, tabs);
    }
    if (tabs.list.length >= MAX_BROWSER_TABS) return undefined;
    const tab: ElectronPage = new ElectronPage(this.session(), tabs.nextId++, {
      onClosed: () => this.forget(sessionId, tab),
      onChanged: () => {
        this.push(sessionId);
        this.apply();
      },
      onWindowOpen: (url, fromAgent, background) => this.openFromPage(sessionId, tab, url, fromAgent, background),
      // Out of the input event first: Cmd+W destroys the very contents that is dispatching it.
      onShortcut: shortcut => setImmediate(() => void this.onShortcut(sessionId, shortcut)),
    });
    tabs.list.push(tab);
    this.byContents.set(tab.contentsId, tab);
    if (activate || !tabs.active) this.activate(sessionId, tab);
    else this.push(sessionId);
    return tab;
  }

  /**
   * A popup or `target=_blank` link, as a tab.
   *
   * The user's own click brings it to the front, as in any browser. The agent's opens behind,
   * so the snapshot its step returns is still of the page it acted on, and the note in that
   * page's events tells it where the new one went.
   */
  private openFromPage(sessionId: string, opener: ElectronPage, url: string, fromAgent: boolean, background: boolean) {
    if (!this.sessions.has(sessionId)) return;
    const tab = this.openTab(sessionId, !fromAgent && !background);
    if (!tab) {
      opener.record(
        `${url} asked for a new tab, but this conversation already has ${MAX_BROWSER_TABS} tabs open, ` +
          'so it opened in this tab instead'
      );
      opener.open(url);
      return;
    }
    tab.open(url);
    const note = `${url} opened in a new tab (tab ${tab.id})`;
    if (this.sessions.get(sessionId)?.active === tab) tab.record(`${note} from tab ${opener.id}`);
    else opener.record(`${note} in the background; browser_tabs with action "select" switches to it`);
  }

  private activate(sessionId: string, tab: ElectronPage): void {
    const tabs = this.sessions.get(sessionId);
    if (!tabs) return;
    if (tabs.active !== tab) tabs.active?.setActive(false);
    tabs.active = tab;
    tab.setActive(true);
    this.push(sessionId);
    this.apply();
  }

  private async closeTab(sessionId: string, tab: ElectronPage): Promise<void> {
    this.forget(sessionId, tab);
    await tab.close();
  }

  /**
   * Take a tab out of its conversation. Runs for an explicit close and again from the tab's own
   * 'destroyed', so it has to be idempotent - and the second time the contents are already gone,
   * which is why the id it removes was read at construction.
   */
  private forget(sessionId: string, tab: ElectronPage): void {
    this.byContents.delete(tab.contentsId);
    if (this.shown === tab) this.shown = undefined;
    const tabs = this.sessions.get(sessionId);
    const index = tabs?.list.indexOf(tab) ?? -1;
    if (!tabs || index < 0) return;
    tabs.list.splice(index, 1);
    if (tabs.active === tab) {
      const neighbour = tabs.list[index] ?? tabs.list[index - 1];
      tabs.active = undefined;
      if (neighbour) {
        this.activate(sessionId, neighbour);
        return;
      }
    }
    this.push(sessionId);
    this.apply();
  }

  private async onShortcut(sessionId: string, shortcut: BrowserTabShortcut): Promise<void> {
    const tabs = this.sessions.get(sessionId);
    if (!tabs?.active) return;
    if (shortcut === 'new') {
      this.openTab(sessionId, true);
      return;
    }
    if (shortcut === 'close') {
      await this.closeTab(sessionId, tabs.active);
      return;
    }
    const step = shortcut === 'next' ? 1 : -1;
    const index = tabs.list.indexOf(tabs.active);
    const target = tabs.list[(index + step + tabs.list.length) % tabs.list.length];
    if (target) this.activate(sessionId, target);
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

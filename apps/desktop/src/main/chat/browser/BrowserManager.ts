import { BrowserWindow, session as electronSession, type Session, type WebContents } from 'electron';
import type { ChatMedia } from '@shared/chat';
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

class ElectronPage implements BrowserPage {
  private readonly window: BrowserWindow;
  private readonly events: string[] = [];
  private lastStatus: number | undefined;
  inflight = 0;
  lastNetworkAt = 0;

  constructor(
    partition: Session,
    private readonly onClosed: () => void
  ) {
    this.window = new BrowserWindow({
      show: false,
      ...VIEWPORT,
      webPreferences: {
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    markAgentBrowserWindow(this.window);
    const contents = this.window.webContents;
    contents.setAudioMuted(true);
    // A popup would be a window nobody can see; open it in this page instead.
    contents.setWindowOpenHandler(({ url }) => {
      void contents.loadURL(url).catch(() => undefined);
      return { action: 'deny' };
    });
    contents.on('did-navigate', (_event, url, status) => {
      this.lastStatus = status;
      this.record(`navigated to ${url}${status ? ` (HTTP ${status})` : ''}`);
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
    this.window.on('closed', () => this.onClosed());
  }

  get contentsId(): number {
    return this.window.webContents.id;
  }

  record(line: string): void {
    this.events.push(line);
    if (this.events.length > MAX_BUFFERED_EVENTS) this.events.splice(0, this.events.length - MAX_BUFFERED_EVENTS);
  }

  private get contents(): WebContents {
    if (this.window.isDestroyed()) throw new Error('The browser was closed.');
    return this.window.webContents;
  }

  currentUrl(): string {
    return this.window.isDestroyed() ? '' : this.window.webContents.getURL();
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
    // A hidden window never holds OS focus, so Enter would not reach a form: submit it directly.
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
      if (this.window.isDestroyed()) return;
      const quiet = this.inflight === 0 && Date.now() - this.lastNetworkAt >= QUIET_MS;
      if (!this.window.webContents.isLoading() && quiet) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async close(): Promise<void> {
    if (!this.window.isDestroyed()) this.window.destroy();
  }
}

/**
 * The agent's browser: one hidden window per conversation, created on first use and closed with
 * the conversation or the app. Main-process only; tools reach it through {@link BrowserContext}.
 */
export class BrowserManager implements BrowserProvider {
  private readonly pages = new Map<string, ElectronPage>();
  private readonly byContents = new Map<number, ElectronPage>();
  private partition: Session | undefined;

  context(
    sessionId: string,
    keepScreenshot: (bytes: Buffer, caption: string) => Promise<ChatMedia | undefined>
  ): BrowserContext {
    return {
      page: async () => this.pageFor(sessionId),
      keepScreenshot,
    };
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.pages.get(sessionId)?.close();
  }

  closeAll(): void {
    for (const page of this.pages.values()) void page.close();
  }

  private pageFor(sessionId: string): ElectronPage {
    const existing = this.pages.get(sessionId);
    if (existing) return existing;
    const page = new ElectronPage(this.session(), () => {
      this.pages.delete(sessionId);
      this.byContents.delete(page.contentsId);
    });
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The page's deadlines, against a fake webContents that can be held open the two ways a real
 * one was seen to hang: a load that never finishes, which Electron makes every page script wait
 * behind until it is stopped, and a renderer busy in its own code, which nothing releases.
 */
const contents = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  const state = {
    handlers: new Map<string, Handler[]>(),
    url: '',
    loadingMainFrame: false,
    stops: 0,
    load: (_url: string): Promise<void> => Promise.resolve(),
    script: (): Promise<unknown> => Promise.resolve(null),
    capture: (): Promise<unknown> => Promise.resolve({ isEmpty: () => true }),
    emit(event: string, ...args: unknown[]) {
      for (const handler of state.handlers.get(event) ?? []) handler({}, ...args);
    },
  };
  return state;
});

vi.mock('electron', () => {
  const webContents = {
    id: 1,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      contents.handlers.set(event, [...(contents.handlers.get(event) ?? []), handler]);
    },
    isDestroyed: () => false,
    getURL: () => contents.url,
    getTitle: () => 'Title',
    isLoading: () => contents.loadingMainFrame,
    isLoadingMainFrame: () => contents.loadingMainFrame,
    loadURL: (url: string) => contents.load(url),
    executeJavaScript: () => contents.script(),
    capturePage: () => contents.capture(),
    stop: () => {
      contents.stops += 1;
      contents.loadingMainFrame = false;
      contents.emit('did-stop-loading');
    },
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    setAudioMuted: () => undefined,
    setWindowOpenHandler: () => undefined,
    close: () => undefined,
  };
  const contentView = { addChildView: () => undefined, removeChildView: () => undefined };
  return {
    BrowserWindow: class {
      contentView = contentView;
      isDestroyed = () => false;
      destroy = () => undefined;
      on = () => undefined;
    },
    WebContentsView: class {
      webContents = webContents;
      setBounds = () => undefined;
    },
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler: () => undefined,
        setPermissionCheckHandler: () => undefined,
        on: () => undefined,
        webRequest: {
          onBeforeRequest: () => undefined,
          onCompleted: () => undefined,
          onErrorOccurred: () => undefined,
        },
      }),
    },
  };
});
vi.mock('../../windows', () => ({ markAgentBrowserWindow: () => undefined }));
vi.mock('./cookies/CookieImporter', () => ({
  CookieImporter: class {
    usesImportedCookies = () => false;
  },
}));

const { BrowserManager } = await import('./BrowserManager');

const never = <T>() => new Promise<T>(() => undefined);

async function openPage() {
  const manager = new BrowserManager();
  return manager.context('session-1', async () => undefined).page();
}

describe('BrowserManager page deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    contents.handlers.clear();
    contents.url = 'http://localhost:3080/before';
    contents.loadingMainFrame = false;
    contents.stops = 0;
    contents.load = () => Promise.resolve();
    contents.script = () => Promise.resolve(null);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Held until stop(), which is how Electron treats a script behind a load that never ends. */
  const heldBehindLoad = <T>(value: T) =>
    new Promise<T>(resolve => {
      contents.loadingMainFrame = true;
      contents.handlers.set('did-stop-loading', [
        ...(contents.handlers.get('did-stop-loading') ?? []),
        () => resolve(value),
      ]);
    });

  it('stops a load that never answers and says so, rather than reporting the old page as loaded', async () => {
    const page = await openPage();
    contents.load = () => never();

    const navigating = page.navigate('http://localhost:3080/slow');
    const failed = expect(navigating).rejects.toThrow(
      'http://localhost:3080/slow did not respond within 30 seconds, so loading was stopped. ' +
        'The browser is still on http://localhost:3080/before.'
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(contents.stops).toBe(1);
  });

  it('keeps a page that arrived but never finished loading, stopped and flagged', async () => {
    const page = await openPage();
    contents.load = url => {
      contents.url = url;
      contents.emit('did-navigate', url, 200);
      return never();
    };

    const navigating = page.navigate('http://localhost:3080/drip');
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(navigating).resolves.toEqual({
      url: 'http://localhost:3080/drip',
      title: 'Title',
      status: 200,
      stillLoading: true,
    });
    expect(contents.stops).toBe(1);
  });

  it('stops a load holding a snapshot past the deadline, which lets the snapshot run', async () => {
    const page = await openPage();
    const snap = { url: 'u', title: 't', text: 'partial page', truncated: false };
    contents.script = () => heldBehindLoad(snap);

    const reading = page.snapshot(1000);
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(reading).resolves.toEqual(snap);
    expect(contents.stops).toBe(1);
    expect(page.drainEvents()).toEqual([expect.stringMatching(/^stopped loading .*still loading after 15 seconds/)]);
  });

  it('fails a snapshot on a page busy in its own code with an error the model can act on', async () => {
    const page = await openPage();
    contents.script = () => never();

    const reading = page.snapshot(1000);
    const failed = expect(reading).rejects.toThrow(
      /^Reading the page did not finish within 15 seconds.*browser_navigate/
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    // Nothing was loading, so there was nothing to stop.
    expect(contents.stops).toBe(0);
  });

  it('bounds every action script, and gives evaluate longer', async () => {
    const page = await openPage();
    contents.script = () => never();

    const click = expect(page.click('1')).rejects.toThrow(
      /^The click did not finish within 15 seconds.*may still happen/
    );
    const fill = expect(page.fill('2', 'x')).rejects.toThrow(/^Filling the field did not finish within 15 seconds/);
    const enter = expect(page.press('Enter')).rejects.toThrow(/^Pressing Enter did not finish within 15 seconds/);
    let evaluated = false;
    const evaluate = page.evaluate('1').catch((err: Error) => {
      evaluated = true;
      return err;
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all([click, fill, enter]);
    expect(evaluated).toBe(false);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(await evaluate).toMatchObject({
      message: expect.stringMatching(/^The script did not finish within 30 seconds/),
    });
  });

  it('bounds a screenshot of a page that never paints', async () => {
    const page = await openPage();
    contents.capture = () => never();

    const capturing = expect(page.screenshot()).rejects.toThrow(/did not paint a frame to capture within 15 seconds/);
    await vi.advanceTimersByTimeAsync(15_000);
    await capturing;
  });
});

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
    nextId: 0,
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
  type Handler = (...args: unknown[]) => void;
  /**
   * Each view gets its own contents. Destroying them clears `view.webContents` BEFORE 'destroyed'
   * is emitted, which is the order Electron uses.
   */
  const makeContents = (view: { webContents?: unknown }) => {
    const own = new Map<string, Handler[]>();
    let destroyed = false;
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      view.webContents = undefined;
      for (const handler of own.get('destroyed') ?? []) handler();
    };
    return {
      id: ++contents.nextId,
      on: (event: string, handler: Handler) => {
        contents.handlers.set(event, [...(contents.handlers.get(event) ?? []), handler]);
        own.set(event, [...(own.get(event) ?? []), handler]);
      },
      isDestroyed: () => destroyed,
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
      close: destroy,
      destroy,
    };
  };
  return {
    BrowserWindow: class {
      private destroyed = false;
      contentView = { addChildView: () => undefined, removeChildView: () => undefined };
      isDestroyed = () => this.destroyed;
      destroy = () => {
        this.destroyed = true;
      };
      on = () => undefined;
    },
    WebContentsView: class {
      webContents: ReturnType<typeof makeContents> | undefined = makeContents(this);
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

const { BrowserWindow } = await import('electron');
const { BrowserManager, NO_PAGE } = await import('./BrowserManager');

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

describe('BrowserManager closing pages', () => {
  type Manager = InstanceType<typeof BrowserManager>;
  type Internals = { pages: Map<string, unknown>; byContents: Map<number, unknown>; pane: unknown };
  const internals = (manager: Manager) => manager as unknown as Internals;
  const bounds = { x: 0, y: 0, width: 600, height: 400 };

  beforeEach(() => {
    contents.handlers.clear();
    contents.url = 'http://localhost:3080/';
  });

  const open = (manager: Manager, sessionId: string) => manager.context(sessionId, async () => undefined).page();

  it('forgets a deleted page whose view lost its contents before destroyed fired', async () => {
    const manager = new BrowserManager();
    const window = new BrowserWindow();
    manager.setPane(window, 'a', bounds);

    await expect(manager.closeSession('a')).resolves.toBeUndefined();

    expect(internals(manager).pages.size).toBe(0);
    expect(internals(manager).byContents.size).toBe(0);
    expect(internals(manager).pane).toBeUndefined();
  });

  it('deletes several notebooks at once, including the one on screen, and keeps the rest', async () => {
    const manager = new BrowserManager();
    const window = new BrowserWindow();
    for (const id of ['a', 'b', 'c', 'd']) await open(manager, id);
    manager.setPane(window, 'b', bounds);

    await Promise.all(['a', 'b', 'c', 'a'].map(id => manager.closeSession(id)));

    const { pages, byContents, pane } = internals(manager);
    expect([...pages.keys()]).toEqual(['d']);
    expect([...byContents.values()]).toEqual([pages.get('d')]);
    expect(pane).toBeUndefined();
  });

  it('answers a tool still holding a page whose contents are gone, without throwing', async () => {
    const manager = new BrowserManager();
    const page = await open(manager, 'a');
    await manager.closeSession('a');

    expect(page.currentUrl()).toBe('');
    expect(() => page.stop()).not.toThrow();
    await expect(page.settle(1_000)).resolves.toBeUndefined();
    await expect(page.navigate('http://localhost:3080/')).rejects.toThrow('The browser was closed.');
    await expect(page.close()).resolves.toBeUndefined();
    expect(manager.setPane(new BrowserWindow(), 'a', null)).toEqual(NO_PAGE);
    expect(() => manager.closeAll()).not.toThrow();
  });
});

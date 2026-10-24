import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserPaneState } from '@shared/ipc';

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
    /** Urls of the frames below the top one. */
    subframes: [] as string[],
    stops: 0,
    nextId: 0,
    /** Every contents made, in order, so a test can reach a tab's own handlers. */
    made: [] as Array<{
      id: number;
      isDestroyed: () => boolean;
      throttled: boolean;
      openHandler?: (details: { url: string; disposition: string }) => { action: string };
      fire: (event: string, ...args: unknown[]) => void;
      destroy: () => void;
    }>,
    loads: [] as Array<{ id: number; url: string }>,
    load: (_url: string): Promise<void> => Promise.resolve(),
    script: (): Promise<unknown> => Promise.resolve(null),
    capture: (..._args: unknown[]): Promise<unknown> => Promise.resolve({ isEmpty: () => true }),
    /** The DevTools protocol, shared by every contents: what a command answers, and who attached. */
    cdp: (_method: string, _params?: unknown): Promise<unknown> => Promise.reject(new Error('no DevTools')),
    debuggerAttached: false,
    attaches: 0,
    detaches: 0,
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
    const id = ++contents.nextId;
    const made = {
      id,
      throttled: false,
      openHandler: undefined as ((details: { url: string; disposition: string }) => { action: string }) | undefined,
      on: (event: string, handler: Handler) => {
        contents.handlers.set(event, [...(contents.handlers.get(event) ?? []), handler]);
        own.set(event, [...(own.get(event) ?? []), handler]);
      },
      isDestroyed: () => destroyed,
      getURL: () => contents.url,
      get mainFrame() {
        return { framesInSubtree: [contents.url, ...contents.subframes].map(url => ({ url })) };
      },
      getTitle: () => 'Title',
      isLoading: () => contents.loadingMainFrame,
      isLoadingMainFrame: () => contents.loadingMainFrame,
      loadURL: (url: string) => {
        contents.loads.push({ id, url });
        return contents.load(url);
      },
      executeJavaScript: () => contents.script(),
      capturePage: (...args: unknown[]) => contents.capture(...args),
      debugger: {
        isAttached: () => contents.debuggerAttached,
        attach: () => {
          if (contents.debuggerAttached) throw new Error('Another debugger is already attached');
          contents.debuggerAttached = true;
          contents.attaches += 1;
        },
        detach: () => {
          contents.debuggerAttached = false;
          contents.detaches += 1;
        },
        sendCommand: (method: string, params?: unknown) => contents.cdp(method, params),
      },
      stop: () => {
        contents.stops += 1;
        contents.loadingMainFrame = false;
        contents.emit('did-stop-loading');
      },
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setAudioMuted: () => undefined,
      setBackgroundThrottling: (allowed: boolean) => {
        made.throttled = allowed;
      },
      setWindowOpenHandler: (handler: (details: { url: string; disposition: string }) => { action: string }) => {
        made.openHandler = handler;
      },
      fire: (event: string, ...args: unknown[]) => {
        for (const handler of own.get(event) ?? []) handler(...args);
      },
      close: destroy,
      destroy,
    };
    contents.made.push(made);
    return made;
  };
  return {
    /** Like Electron: a destroyed window throws on `contentView`, and destroy() emits 'closed' at once. */
    BrowserWindow: class {
      private destroyed = false;
      private readonly own = new Map<string, Handler[]>();
      readonly children = new Set<unknown>();
      private readonly view = {
        addChildView: (child: unknown) => void this.children.add(child),
        removeChildView: (child: unknown) => void this.children.delete(child),
      };
      get contentView() {
        if (this.destroyed) throw new TypeError('Object has been destroyed');
        return this.view;
      }
      isDestroyed = () => this.destroyed;
      destroy = () => {
        if (this.destroyed) return;
        this.destroyed = true;
        for (const handler of this.own.get('closed') ?? []) handler();
      };
      on = (event: string, handler: Handler) => {
        this.own.set(event, [...(this.own.get(event) ?? []), handler]);
      };
    },
    WebContentsView: class {
      webContents: ReturnType<typeof makeContents> | undefined = makeContents(this);
      bounds: unknown;
      visible = true;
      setBounds = (bounds: unknown) => {
        this.bounds = bounds;
      };
      setVisible = (visible: boolean) => {
        this.visible = visible;
      };
    },
    /** A PNG "decodes" to an image that remembers its bytes, at a Retina viewport. */
    nativeImage: {
      createFromBuffer: (bytes: Buffer) => ({
        isEmpty: () => bytes.length === 0,
        getSize: () => ({ width: 2560, height: 1600 }),
        resize: ({ width }: { width: number }) => ({ toPNG: () => Buffer.from(`${bytes.toString()}@${width}`) }),
        toPNG: () => bytes,
      }),
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
const { MAX_BROWSER_TABS } = await import('@shared/browserTabs');
const { resolveAddress } = await import('@shared/browserUrl');

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
    const model = {
      url: 'u',
      title: 't',
      capturedAt: '2026-10-24T12:00:00.000Z',
      blocks: [],
      actions: [],
      claims: [],
      truncated: false,
    };
    const snap = { url: 'u', title: 't', text: 'partial page', truncated: false, model };
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

  it('bounds a screenshot of a page that never paints, and lets go of the debugger it attached', async () => {
    const page = await openPage();
    contents.cdp = () => never();
    contents.detaches = 0;

    const capturing = expect(page.screenshot()).rejects.toThrow(/did not paint a frame to capture within 15 seconds/);
    await vi.advanceTimersByTimeAsync(15_000);
    await capturing;
    expect(contents.debuggerAttached).toBe(false);
    expect(contents.detaches).toBe(1);
  });

  it('lists every frame a screenshot would show, the top one first', async () => {
    const page = await openPage();
    contents.subframes = ['https://mail.example.com/inbox', 'about:blank'];
    try {
      expect(page.frameUrls()).toEqual([contents.url, 'https://mail.example.com/inbox', 'about:blank']);
    } finally {
      contents.subframes = [];
    }
  });
});

describe('BrowserManager closing pages', () => {
  type Manager = InstanceType<typeof BrowserManager>;
  type Internals = {
    sessions: Map<string, { list: unknown[] }>;
    byContents: Map<number, unknown>;
    pane: unknown;
    shown: unknown;
  };
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
    await open(manager, 'a');
    manager.setPane(window, 'a', bounds);

    await expect(manager.closeSession('a')).resolves.toBeUndefined();

    expect(internals(manager).sessions.size).toBe(0);
    expect(internals(manager).byContents.size).toBe(0);
    expect(internals(manager).shown).toBeUndefined();
  });

  it('shows the next tab of a conversation still on screen after its tabs were closed by archiving', async () => {
    const manager = new BrowserManager();
    const window = new BrowserWindow();
    await open(manager, 'a');
    manager.setPane(window, 'a', bounds);
    await manager.closeSession('a');

    const reopened = await open(manager, 'a');

    expect(internals(manager).shown).toBe(reopened);
  });

  it('deletes several notebooks at once, including the one on screen, and keeps the rest', async () => {
    const manager = new BrowserManager();
    const window = new BrowserWindow();
    for (const id of ['a', 'b', 'c', 'd']) await open(manager, id);
    manager.setPane(window, 'b', bounds);

    await Promise.all(['a', 'b', 'c', 'a'].map(id => manager.closeSession(id)));

    const { sessions, byContents, shown } = internals(manager);
    expect([...sessions.keys()]).toEqual(['d']);
    expect([...byContents.values()]).toEqual(sessions.get('d')?.list);
    expect(shown).toBeUndefined();
  });

  it('answers a tool still holding a page whose contents are gone, without throwing', async () => {
    const manager = new BrowserManager();
    const page = await open(manager, 'a');
    await manager.closeSession('a');

    expect(page.currentUrl()).toBe('');
    expect(page.frameUrls()).toEqual([]);
    expect(() => page.stop()).not.toThrow();
    await expect(page.settle(1_000)).resolves.toBeUndefined();
    await expect(page.navigate('http://localhost:3080/')).rejects.toThrow('The browser was closed.');
    await expect(page.close()).resolves.toBeUndefined();
    expect(manager.setPane(new BrowserWindow(), 'a', null)).toEqual(NO_PAGE);
    expect(() => manager.closeAll()).not.toThrow();
  });

  it('opens no tab just because the pane is showing the conversation', () => {
    const before = contents.made.length;
    const manager = new BrowserManager();
    expect(manager.setPane(new BrowserWindow(), 'a', bounds)).toEqual(NO_PAGE);
    expect(internals(manager).sessions.size).toBe(0);
    expect(contents.made).toHaveLength(before);
  });
});

describe('BrowserManager tabs', () => {
  type Manager = InstanceType<typeof BrowserManager>;
  type Internals = {
    sessions: Map<string, { list: unknown[] }>;
    byContents: Map<number, unknown>;
    pane: unknown;
    shown: unknown;
  };
  const internals = (manager: Manager) => manager as unknown as Internals;
  const bounds = { x: 0, y: 0, width: 600, height: 400 };
  const mac = process.platform === 'darwin';

  let states: BrowserPaneState[];
  let manager: Manager;
  const context = () => manager.context('s', async () => undefined);
  const lastState = () => states.at(-1)!;
  const tabIds = () => lastState().tabs.map(tab => tab.id);
  let baseline = 0;
  /** The contents of the nth tab this test opened, counting from 1. */
  const nth = (n: number) => contents.made[baseline + n - 1];

  beforeEach(() => {
    contents.handlers.clear();
    contents.url = 'http://localhost:3080/';
    contents.load = () => Promise.resolve();
    contents.script = () => Promise.resolve(null);
    contents.loads = [];
    baseline = contents.made.length;
    states = [];
    manager = new BrowserManager((_sessionId, state) => states.push(state));
  });

  it('opens tabs in order, switches between them and throttles all but the active one', async () => {
    await context().page();
    await context().newTab();
    await context().newTab();

    expect(tabIds()).toEqual([1, 2, 3]);
    expect(lastState().activeTabId).toBe(3);
    expect([1, 2, 3].map(n => nth(n).throttled)).toEqual([true, true, false]);

    await expect(context().selectTab(1)).resolves.toMatchObject({ id: 1, active: true });
    expect(lastState().activeTabId).toBe(1);
    expect([1, 2, 3].map(n => nth(n).throttled)).toEqual([false, true, true]);
    expect(
      context()
        .tabs()
        .map(tab => [tab.id, tab.active])
    ).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
    expect(internals(manager).byContents.size).toBe(3);
  });

  it('hands the active slot to the neighbour on the right, else the left, when the active tab closes', async () => {
    await context().page();
    await context().newTab();
    await context().newTab();
    await context().selectTab(2);

    await context().closeTab(2);
    expect(tabIds()).toEqual([1, 3]);
    expect(lastState().activeTabId).toBe(3);

    await context().closeTab(3);
    expect(lastState().activeTabId).toBe(1);
    expect(internals(manager).byContents.size).toBe(1);
  });

  it('never reuses an id within the conversation, even after every tab closed', async () => {
    await context().page();
    await context().closeTab(1);
    await context().page();
    expect(tabIds()).toEqual([2]);
  });

  it('leaves an empty pane when the last tab closes, and does not reopen one on the next report', async () => {
    const window = new BrowserWindow();
    await context().page();
    manager.setPane(window, 's', bounds);

    await expect(manager.tab('s', 'close', 1)).resolves.toEqual(NO_PAGE);
    expect(lastState()).toEqual(NO_PAGE);
    expect(internals(manager).pane).toBeDefined();
    expect(manager.setPane(window, 's', { ...bounds, width: 700 })).toEqual(NO_PAGE);
    expect(internals(manager).sessions.get('s')?.list).toEqual([]);
  });

  it('opens a popup the user caused as a new active tab, and keeps the opener', async () => {
    await context().page();

    expect(nth(1).openHandler?.({ url: 'https://example.com/help', disposition: 'foreground-tab' })).toEqual({
      action: 'deny',
    });

    expect(tabIds()).toEqual([1, 2]);
    expect(lastState().activeTabId).toBe(2);
    expect(contents.loads).toEqual([{ id: contents.made.at(-1)!.id, url: 'https://example.com/help' }]);
    expect((await context().page()).drainEvents()).toEqual([
      'https://example.com/help opened in a new tab (tab 2) from tab 1',
    ]);
  });

  it('opens a popup the agent caused behind, and tells the agent where it went', async () => {
    const page = await context().page();
    contents.script = () => {
      nth(1).openHandler?.({ url: 'https://example.com/terms', disposition: 'foreground-tab' });
      return Promise.resolve({ ok: true, description: 'link "Terms"' });
    };

    await page.click('4');

    expect(tabIds()).toEqual([1, 2]);
    expect(lastState().activeTabId).toBe(1);
    expect(page.drainEvents()).toEqual([
      'https://example.com/terms opened in a new tab (tab 2) in the background; browser_tabs with action "select" switches to it',
    ]);
  });

  it('refuses a popup to anything but http and https, and says so', async () => {
    const page = await context().page();

    expect(nth(1).openHandler?.({ url: 'file:///etc/passwd', disposition: 'foreground-tab' })).toEqual({
      action: 'deny',
    });

    expect(tabIds()).toEqual([1]);
    expect(contents.loads).toEqual([]);
    expect(page.drainEvents()).toEqual([
      'blocked a popup to file:///etc/passwd: only http and https pages open in a tab',
    ]);
  });

  it('loads a popup in the tab that asked once the conversation is at the cap, and says so', async () => {
    await context().page();
    while ((await context().newTab()) !== null);
    expect(tabIds()).toHaveLength(MAX_BROWSER_TABS);
    const active = await context().page();
    active.drainEvents();

    nth(MAX_BROWSER_TABS).openHandler?.({ url: 'https://example.com/more', disposition: 'foreground-tab' });

    expect(tabIds()).toHaveLength(MAX_BROWSER_TABS);
    expect(contents.loads).toEqual([{ id: nth(MAX_BROWSER_TABS).id, url: 'https://example.com/more' }]);
    expect(active.drainEvents()).toEqual([
      `https://example.com/more asked for a new tab, but this conversation already has ${MAX_BROWSER_TABS} tabs open, so it opened in this tab instead`,
    ]);
    await expect(manager.tab('s', 'new')).resolves.toMatchObject({ activeTabId: MAX_BROWSER_TABS });
    expect(tabIds()).toHaveLength(MAX_BROWSER_TABS);
  });

  it('closes every tab with the conversation', async () => {
    await context().page();
    await context().newTab();
    await context().newTab();

    await manager.closeSession('s');

    expect([1, 2, 3].map(n => nth(n).isDestroyed())).toEqual([true, true, true]);
    expect(internals(manager).sessions.size).toBe(0);
    expect(internals(manager).byContents.size).toBe(0);
  });

  it('copes with a tab whose contents went away on their own', async () => {
    const window = new BrowserWindow();
    const first = await context().page();
    await context().newTab();
    manager.setPane(window, 's', bounds);

    expect(() => nth(2).destroy()).not.toThrow();

    expect(tabIds()).toEqual([1]);
    expect(lastState().activeTabId).toBe(1);
    expect(await context().page()).toBe(first);
    await expect(manager.tab('s', 'close', 2)).resolves.toMatchObject({ activeTabId: 1 });
    await expect(context().selectTab(2)).rejects.toThrow('There is no tab 2.');
    expect(internals(manager).byContents.size).toBe(1);
  });

  it('takes the tab shortcuts from inside the page, where the renderer hears no keys', async () => {
    await context().page();
    const press = (n: number, code: string, shift = false) => {
      const event = { preventDefault: vi.fn() };
      nth(n).fire('before-input-event', event, { type: 'keyDown', code, shift, alt: false, meta: mac, control: !mac });
      return event.preventDefault;
    };

    expect(press(1, 'KeyT')).toHaveBeenCalled();
    await vi.waitFor(() => expect(lastState().activeTabId).toBe(2));
    press(2, 'BracketLeft', true);
    await vi.waitFor(() => expect(lastState().activeTabId).toBe(1));
    press(1, 'BracketLeft', true);
    await vi.waitFor(() => expect(lastState().activeTabId).toBe(2));
    press(2, 'KeyW');
    await vi.waitFor(() => expect(tabIds()).toEqual([1]));
    expect(press(1, 'KeyA')).not.toHaveBeenCalled();
  });
});

describe('BrowserManager when a page outlives its hidden host', () => {
  type Manager = InstanceType<typeof BrowserManager>;
  type Window = InstanceType<typeof BrowserWindow> & { children: Set<unknown> };
  type Page = { host: Window & { destroyed: boolean }; view: { visible: boolean } };
  const parts = (page: unknown) => page as Page;
  const shown = (manager: Manager) => (manager as unknown as { shown: unknown }).shown;
  const bounds = { x: 1440, y: 40, width: 560, height: 760 };

  let states: BrowserPaneState[];
  let manager: Manager;
  let window: Window;
  let baseline = 0;
  const nth = (n: number) => contents.made[baseline + n - 1];
  const lastState = () => states.at(-1)!;
  const context = () => manager.context('s', async () => undefined);

  /** What the url bar sends for typed text that is not an address. */
  const search = (text: string) => {
    const resolved = resolveAddress(text);
    if (!resolved.ok) throw new Error(resolved.error);
    return manager.navigate('s', resolved.url);
  };

  beforeEach(() => {
    contents.handlers.clear();
    contents.url = '';
    contents.loads = [];
    contents.script = () => Promise.resolve(null);
    // Google answers a search by redirecting to itself with a session parameter, which aborts
    // the first load after it already committed.
    contents.load = url => {
      contents.url = `${url}&sei=abc`;
      contents.emit('did-navigate', contents.url, 200);
      return Promise.reject(new Error(`ERR_ABORTED (-3) loading '${url}'`));
    };
    baseline = contents.made.length;
    states = [];
    manager = new BrowserManager((_sessionId, state) => states.push(state));
    window = new BrowserWindow() as Window;
  });

  it('shows an address-bar search in the pane', async () => {
    manager.setPane(window, 's', bounds);

    const state = await search('electron object has been destroyed');

    expect(contents.loads).toEqual([
      { id: nth(1).id, url: 'https://www.google.com/search?q=electron%20object%20has%20been%20destroyed' },
    ]);
    expect(state).toMatchObject({ url: expect.stringContaining('google.com/search?q='), error: '', activeTabId: 1 });
    const page = shown(manager);
    expect(window.children.has(parts(page).view)).toBe(true);
  });

  it('drops the tab cleanly when its host is closed under it, and the next search opens a new one', async () => {
    manager.setPane(window, 's', bounds);
    await search('first search');
    const page = parts(shown(manager));

    expect(() => page.host.destroy()).not.toThrow();

    expect(nth(1).isDestroyed()).toBe(true);
    expect(window.children.has(page.view)).toBe(false);
    expect(shown(manager)).toBeUndefined();
    expect(lastState()).toEqual(NO_PAGE);
    expect(() => manager.setPane(window, null, null)).not.toThrow();
    expect(() => manager.setPane(window, 's', bounds)).not.toThrow();

    await expect(search('second search')).resolves.toMatchObject({ activeTabId: 2, tabs: [{ id: 2 }] });
    expect(window.children.has(parts(shown(manager)).view)).toBe(true);
  });

  it('does not throw when the page fires events after its host is gone and before its contents are', async () => {
    manager.setPane(window, 's', bounds);
    await search('a search');
    // Electron destroys closed contents on a later task, so they still emit in between.
    const page = parts(shown(manager));
    const first = Object.assign(nth(1), { close: () => undefined });

    page.host.destroy();

    for (const event of ['did-stop-loading', 'did-navigate', 'page-title-updated', 'did-start-loading']) {
      expect(() => first.fire(event, {}, 'https://www.google.com/', 200)).not.toThrow();
    }
    expect(shown(manager)).toBeUndefined();
    expect(() => first.destroy()).not.toThrow();
    expect(lastState()).toEqual(NO_PAGE);
  });

  it('parks, shows and closes a page whose host died without saying so, and keeps serving the pane', async () => {
    manager.setPane(window, 's', bounds);
    await search('a search');
    const broken = parts(shown(manager));
    // Destroyed with no 'closed' delivered: every placement still has to hold up.
    broken.host.destroyed = true;

    expect(() => manager.setPane(window, null, null)).not.toThrow();
    expect(window.children.has(broken.view)).toBe(false);
    expect(() => manager.setPane(window, 's', bounds)).not.toThrow();
    expect(shown(manager)).toBeUndefined();
    expect(() => manager.setPane(window, 's', null)).not.toThrow();
    await expect(manager.tab('s', 'new')).resolves.toMatchObject({ activeTabId: 2 });
    await expect(manager.tab('s', 'select', 1)).resolves.toMatchObject({ activeTabId: 1 });

    await expect(manager.tab('s', 'close', 1)).resolves.toMatchObject({ activeTabId: 2, tabs: [{ id: 2 }] });
    expect(nth(1).isDestroyed()).toBe(true);
    await expect(search('after the broken tab')).resolves.toMatchObject({ activeTabId: 2, error: '' });
  });

  it('closes the hidden host of a page that closed itself', async () => {
    await search('a search');
    const page = parts(await context().page());

    nth(1).destroy();

    expect(page.host.isDestroyed()).toBe(true);
    expect(manager.context('s', async () => undefined).tabs()).toEqual([]);
  });

  it('logs a placement failure once, answers the request anyway, and recovers on the next one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await search('a search');
      const page = (await context().page()) as unknown as { showIn: () => void };
      const showIn = vi.spyOn(page, 'showIn').mockImplementation(() => {
        throw new TypeError('Object has been destroyed');
      });

      expect(manager.setPane(window, 's', bounds)).toMatchObject({ activeTabId: 1 });
      expect(manager.setPane(window, 's', { ...bounds, width: 600 })).toMatchObject({ activeTabId: 1 });
      expect(() => nth(1).fire('did-stop-loading')).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/^BROWSER: could not place the page: TypeError: Object has been destroyed/);

      showIn.mockRestore();
      manager.setPane(window, 's', bounds);
      expect(shown(manager)).toBe(page);
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['hide', 'switch'] as const)('retries parking after a failed pane %s', async action => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      manager.setPane(window, 's', bounds);
      await search('a search');
      const page = await context().page();
      const park = vi.spyOn(page as unknown as { park: () => void }, 'park').mockImplementationOnce(() => {
        throw new Error('placement failed');
      });

      const hide = () => manager.setPane(window, action === 'hide' ? null : 'other', bounds);
      expect(hide).not.toThrow();
      expect(window.children.has(parts(page).view)).toBe(true);

      expect(hide).not.toThrow();
      expect(park).toHaveBeenCalledTimes(2);
      expect(window.children.has(parts(page).view)).toBe(false);
      expect(shown(manager)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('parks a partially placed page when the next request switches conversations', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await search('a search');
      const page = await context().page();
      const view = parts(page).view as { visible: boolean; setBounds: (bounds: unknown) => void };
      vi.spyOn(view, 'setBounds').mockImplementationOnce(() => {
        throw new Error('bounds failed after attaching');
      });

      expect(() => manager.setPane(window, 's', bounds)).not.toThrow();
      expect(window.children.has(view)).toBe(true);

      manager.setPane(window, 'other', bounds);
      expect(window.children.has(view)).toBe(false);
      expect(shown(manager)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('BrowserManager holding the pane for an overlay', () => {
  type Manager = InstanceType<typeof BrowserManager>;
  type View = { visible: boolean; bounds: unknown };
  const view = (page: unknown) => (page as { view: View }).view;
  const shown = (manager: Manager) => (manager as unknown as { shown: unknown }).shown;
  const bounds = { x: 1440, y: 40, width: 560, height: 760 };
  const jpeg = { isEmpty: () => false, toJPEG: (quality: number) => Buffer.from(`jpeg@${quality}`) };

  let manager: Manager;
  let window: InstanceType<typeof BrowserWindow>;
  const context = () => manager.context('s', async () => undefined);

  beforeEach(() => {
    contents.handlers.clear();
    contents.url = 'http://localhost:3080/';
    contents.capture = () => Promise.resolve(jpeg);
    manager = new BrowserManager();
    window = new BrowserWindow();
  });

  it('hides the page where it is rather than parking it at the tool viewport', async () => {
    const page = await context().page();
    manager.setPane(window, 's', bounds);
    expect(view(page)).toMatchObject({ visible: true, bounds });

    manager.setPane(window, 's', null);
    expect(view(page)).toMatchObject({ visible: false, bounds });
    expect(shown(manager)).toBe(page);

    manager.setPane(window, 's', bounds);
    expect(view(page).visible).toBe(true);
  });

  it('captures the held active tab without putting it back on screen', async () => {
    await context().page();
    const active = await context().newTab();
    manager.setPane(window, 's', bounds);
    manager.setPane(window, 's', null);
    const capture = vi.fn((..._args: unknown[]) => Promise.resolve(jpeg));
    contents.capture = capture;

    await expect(manager.freezeFrame(window, 's')).resolves.toBe(
      `data:image/jpeg;base64,${Buffer.from('jpeg@80').toString('base64')}`
    );
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][1]).toEqual({ stayHidden: true });
    expect(shown(manager)).toBe(active);
    expect(view(active).visible).toBe(false);
  });

  it('has no still for a page that is on screen, or for another window or conversation', async () => {
    await context().page();
    manager.setPane(window, 's', bounds);
    await expect(manager.freezeFrame(window, 's')).resolves.toBeNull();

    manager.setPane(window, 's', null);
    await expect(manager.freezeFrame(new BrowserWindow(), 's')).resolves.toBeNull();
    await expect(manager.freezeFrame(window, 'other')).resolves.toBeNull();
  });

  it('drops a still whose hold ended while it was being captured', async () => {
    await context().page();
    manager.setPane(window, 's', bounds);
    manager.setPane(window, 's', null);
    let finish: (image: unknown) => void = () => undefined;
    contents.capture = () => new Promise(resolve => (finish = resolve));

    const still = manager.freezeFrame(window, 's');
    manager.setPane(window, 's', bounds);
    finish(jpeg);
    await expect(still).resolves.toBeNull();
  });

  it('gives null for a page that painted nothing, or whose capture failed', async () => {
    await context().page();
    manager.setPane(window, 's', bounds);
    manager.setPane(window, 's', null);
    contents.capture = () => Promise.resolve({ isEmpty: () => true });
    await expect(manager.freezeFrame(window, 's')).resolves.toBeNull();
    contents.capture = () => Promise.reject(new Error('gone'));
    await expect(manager.freezeFrame(window, 's')).resolves.toBeNull();
  });

  it('parks the old tab on a switch during the hold and shows the new one only when it ends', async () => {
    const first = await context().page();
    manager.setPane(window, 's', bounds);
    manager.setPane(window, 's', null);

    const second = await context().newTab();
    expect(view(first)).toMatchObject({ visible: true, bounds: { x: 0, y: 0, width: 1280, height: 800 } });
    expect(shown(manager)).toBeUndefined();
    await expect(manager.freezeFrame(window, 's')).resolves.toBeNull();

    manager.setPane(window, 's', bounds);
    expect(shown(manager)).toBe(second);
    expect(view(second)).toMatchObject({ visible: true, bounds });
  });

  it('parks the page when the request names another conversation, as before', async () => {
    const page = await context().page();
    manager.setPane(window, 's', bounds);
    manager.setPane(window, 'other', null);
    expect(shown(manager)).toBeUndefined();
    expect(view(page)).toMatchObject({ visible: true, bounds: { x: 0, y: 0, width: 1280, height: 800 } });
  });
});

describe('BrowserManager screenshots', () => {
  const SURFACE_ERROR = 'Current display surface not available for capture';
  const bounds = { x: 1440, y: 40, width: 560, height: 760 };
  const frame = {
    isEmpty: () => false,
    getSize: () => ({ width: 1120, height: 1520 }),
    toPNG: () => Buffer.from('pane'),
  };
  const png = (text: string) => ({ data: Buffer.from(text).toString('base64') });

  let manager: InstanceType<typeof BrowserManager>;
  let window: InstanceType<typeof BrowserWindow>;
  let cdp: ReturnType<typeof vi.fn<(method: string, params?: unknown) => Promise<unknown>>>;
  const page = () => manager.context('s', async () => undefined).page();

  beforeEach(() => {
    contents.handlers.clear();
    contents.url = 'https://example.com/';
    contents.debuggerAttached = false;
    contents.attaches = 0;
    contents.detaches = 0;
    contents.capture = () => Promise.resolve(frame);
    cdp = vi.fn(() => Promise.resolve(png('devtools')));
    contents.cdp = cdp;
    manager = new BrowserManager();
    window = new BrowserWindow();
  });

  it('draws a parked page through DevTools, which needs no display surface, at the tool viewport', async () => {
    const capture = vi.fn(() => Promise.reject(new Error(SURFACE_ERROR)));
    contents.capture = capture;

    await expect((await page()).screenshot()).resolves.toEqual(Buffer.from('devtools@1280'));
    expect(capture).not.toHaveBeenCalled();
    expect(cdp).toHaveBeenCalledWith('Page.captureScreenshot', { format: 'png' });
    expect({ attaches: contents.attaches, detaches: contents.detaches }).toEqual({ attaches: 1, detaches: 1 });
    expect(contents.debuggerAttached).toBe(false);
  });

  it('captures a page on screen in the pane as before, without the debugger', async () => {
    const tab = await page();
    manager.setPane(window, 's', bounds);

    await expect(tab.screenshot()).resolves.toEqual(Buffer.from('pane'));
    expect(cdp).not.toHaveBeenCalled();
    expect(contents.attaches).toBe(0);
  });

  it('falls back to DevTools when the pane has no surface or an empty frame to read', async () => {
    const tab = await page();
    manager.setPane(window, 's', bounds);

    contents.capture = () => Promise.reject(new Error(SURFACE_ERROR));
    await expect(tab.screenshot()).resolves.toEqual(Buffer.from('devtools@1280'));
    contents.capture = () => Promise.resolve({ isEmpty: () => true });
    await expect(tab.screenshot()).resolves.toEqual(Buffer.from('devtools@1280'));
    expect(contents.detaches).toBe(2);
  });

  it('never calls capturePage on a held page, which would put it back on screen', async () => {
    const tab = await page();
    manager.setPane(window, 's', bounds);
    manager.setPane(window, 's', null);
    const capture = vi.fn(() => Promise.resolve(frame));
    contents.capture = capture;

    await expect(tab.screenshot()).resolves.toEqual(Buffer.from('devtools@1280'));
    expect(capture).not.toHaveBeenCalled();
  });

  it('says what to do instead when neither capture works, rather than passing on the Chromium error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const tab = await page();
      manager.setPane(window, 's', bounds);
      contents.capture = () => Promise.reject(new Error(SURFACE_ERROR));
      contents.cdp = () => Promise.reject(new Error('Target closed'));

      const failure = await tab.screenshot().catch((err: Error) => err);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/^Could not capture a screenshot of this page\. browser_snapshot/);
      expect((failure as Error).message).not.toContain(SURFACE_ERROR);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(SURFACE_ERROR));
      expect(contents.debuggerAttached).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('says the page rendered nothing when DevTools draws an empty frame', async () => {
    contents.cdp = () => Promise.resolve({ data: '' });
    await expect((await page()).screenshot()).rejects.toThrow('The page rendered nothing to capture yet.');
  });

  /** Each DevTools command waits for its own answer, in the order they were sent. */
  const heldCommands = () => {
    const answers: Array<(result: unknown) => void> = [];
    contents.cdp = () => new Promise(resolve => answers.push(resolve));
    return answers;
  };

  it('does not start an abandoned fallback while a retry is using the debugger', async () => {
    vi.useFakeTimers();
    try {
      const tab = await page();
      manager.setPane(window, 's', bounds);
      let answer: (image: unknown) => void = () => undefined;
      contents.capture = () => new Promise(resolve => (answer = resolve));

      const timedOut = expect(tab.screenshot()).rejects.toThrow(/did not paint a frame/);
      await vi.advanceTimersByTimeAsync(15_000);
      await timedOut;

      // The retry is mid-DevTools capture when the abandoned capturePage comes back empty.
      const answers = heldCommands();
      contents.capture = () => Promise.reject(new Error(SURFACE_ERROR));
      const retry = tab.screenshot();
      await vi.advanceTimersByTimeAsync(0);
      answer({ isEmpty: () => true });
      await vi.advanceTimersByTimeAsync(0);
      expect(answers).toHaveLength(1);

      answers[0](png('retry'));
      await expect(retry).resolves.toEqual(Buffer.from('retry@1280'));
      expect({ attaches: contents.attaches, detaches: contents.detaches }).toEqual({ attaches: 1, detaches: 1 });
      expect(contents.debuggerAttached).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['empty', 'rejected'])('does not attach after a timed-out pane capture returns %s', async outcome => {
    vi.useFakeTimers();
    try {
      const tab = await page();
      manager.setPane(window, 's', bounds);
      let finish: () => void = () => undefined;
      contents.capture = () =>
        new Promise((resolve, reject) => {
          finish = () => (outcome === 'empty' ? resolve({ isEmpty: () => true }) : reject(new Error(SURFACE_ERROR)));
        });
      const timedOut = expect(tab.screenshot()).rejects.toThrow(/did not paint a frame/);
      await vi.advanceTimersByTimeAsync(15_000);
      await timedOut;
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(cdp).not.toHaveBeenCalled();
      expect(contents.attaches).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a later capture alive when the first times out and finishes late', async () => {
    vi.useFakeTimers();
    try {
      const tab = await page();
      const answers = heldCommands();
      const first = expect(tab.screenshot()).rejects.toThrow(/did not paint a frame/);
      await vi.advanceTimersByTimeAsync(10_000);
      const second = tab.screenshot();
      await vi.advanceTimersByTimeAsync(5_000);
      await first;
      expect(contents.debuggerAttached).toBe(true);
      expect(contents.detaches).toBe(0);
      answers[0](png('late'));
      await vi.advanceTimersByTimeAsync(0);
      expect(contents.debuggerAttached).toBe(true);
      answers[1](png('second'));
      await expect(second).resolves.toEqual(Buffer.from('second@1280'));
      expect({ attaches: contents.attaches, detaches: contents.detaches }).toEqual({ attaches: 1, detaches: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])('keeps late cleanup out of a new capture (external debugger: %s)', async external => {
    vi.useFakeTimers();
    try {
      contents.debuggerAttached = external;
      const tab = await page();
      const answers = heldCommands();
      const first = expect(tab.screenshot()).rejects.toThrow(/did not paint a frame/);
      await vi.advanceTimersByTimeAsync(15_000);
      await first;
      expect(contents.debuggerAttached).toBe(external);
      expect(contents.detaches).toBe(external ? 0 : 1);

      const retry = tab.screenshot();
      answers[0](png('late'));
      await vi.advanceTimersByTimeAsync(0);
      expect(contents.debuggerAttached).toBe(true);
      answers[1](png('retry'));
      await expect(retry).resolves.toEqual(Buffer.from('retry@1280'));
      expect(contents.debuggerAttached).toBe(external);
      expect(contents.attaches).toBe(external ? 0 : 2);
      expect(contents.detaches).toBe(external ? 0 : 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets two screenshots from one round share the debugger, detaching after the last', async () => {
    const tab = await page();
    const answers = heldCommands();
    const first = tab.screenshot();
    const second = tab.screenshot();
    await vi.waitFor(() => expect(answers).toHaveLength(2));

    answers[0](png('first'));
    await expect(first).resolves.toEqual(Buffer.from('first@1280'));
    expect(contents.debuggerAttached).toBe(true);
    answers[1](png('second'));
    await expect(second).resolves.toEqual(Buffer.from('second@1280'));
    expect({ attaches: contents.attaches, detaches: contents.detaches }).toEqual({ attaches: 1, detaches: 1 });
  });

  it('uses a debugger something else attached, and leaves it attached', async () => {
    contents.debuggerAttached = true;

    await expect((await page()).screenshot()).resolves.toEqual(Buffer.from('devtools@1280'));
    expect({ attaches: contents.attaches, detaches: contents.detaches }).toEqual({ attaches: 0, detaches: 0 });
    expect(contents.debuggerAttached).toBe(true);
  });
});

describe('BrowserManager snapshot indexing', () => {
  const snapshot = {
    url: 'https://example.com/',
    title: 'Example',
    text: 'moon',
    truncated: false,
    model: {
      url: 'https://example.com/',
      title: 'Example',
      capturedAt: '2026-10-24T12:00:00.000Z',
      blocks: [{ id: 'b1', kind: 'text', text: 'moon' }],
      actions: [],
      claims: [],
      truncated: false,
    },
  };

  beforeEach(() => {
    contents.handlers.clear();
    contents.loadingMainFrame = false;
    contents.script = () => Promise.resolve(snapshot);
  });

  it('passes the validated snapshot and owning session identity to the indexer', async () => {
    const index = vi.fn();
    const manager = new BrowserManager(undefined, undefined, index);
    const first = await manager.context('first', async () => undefined).page();
    const second = await manager.context('second', async () => undefined).page();
    const parsed = await first.snapshot(1000);
    expect(index).toHaveBeenLastCalledWith('first', parsed);
    expect(index.mock.calls[0][1]).toBe(parsed);
    await second.snapshot(1000);
    expect(index).toHaveBeenLastCalledWith('second', snapshot);
    manager.closeAll();
  });

  it.each(['synchronous', 'asynchronous'])('reports %s indexing failures without losing the snapshot', async kind => {
    const error = new Error('history disk failure');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const manager = new BrowserManager(undefined, undefined, () => {
        if (kind === 'synchronous') throw error;
        return Promise.reject(error);
      });
      const page = await manager.context('first', async () => undefined).page();
      await expect(page.snapshot(1000)).resolves.toEqual(snapshot);
      expect(warn).toHaveBeenCalledWith('BROWSER: could not index page snapshot:', error);
      manager.closeAll();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not send an invalid snapshot to the indexer', async () => {
    const index = vi.fn();
    const manager = new BrowserManager(undefined, undefined, index);
    const page = await manager.context('first', async () => undefined).page();
    contents.script = () => Promise.resolve({ ...snapshot, model: { ...snapshot.model, capturedAt: 'invalid' } });
    await expect(page.snapshot(1000)).rejects.toThrow();
    expect(index).not.toHaveBeenCalled();
    manager.closeAll();
  });

  it('ignores a late snapshot from a closed tab even if the same session reopened', async () => {
    const index = vi.fn();
    const manager = new BrowserManager(undefined, undefined, index);
    const page = await manager.context('first', async () => undefined).page();
    let finish: (value: typeof snapshot) => void = () => undefined;
    contents.script = () =>
      new Promise(resolve => {
        finish = resolve;
      });
    const pending = page.snapshot(1000);
    manager.closeAll();
    await manager.context('first', async () => undefined).page();
    finish(snapshot);
    await pending;
    expect(index).not.toHaveBeenCalled();
    manager.closeAll();
  });
});

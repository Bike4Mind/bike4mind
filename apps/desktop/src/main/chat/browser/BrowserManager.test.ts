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
      getTitle: () => 'Title',
      isLoading: () => contents.loadingMainFrame,
      isLoadingMainFrame: () => contents.loadingMainFrame,
      loadURL: (url: string) => {
        contents.loads.push({ id, url });
        return contents.load(url);
      },
      executeJavaScript: () => contents.script(),
      capturePage: () => contents.capture(),
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
const { MAX_BROWSER_TABS } = await import('@shared/browserTabs');

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
  type Internals = { sessions: Map<string, { list: unknown[] }>; byContents: Map<number, unknown>; pane: unknown };
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
    expect(internals(manager).pane).toBeUndefined();
  });

  it('deletes several notebooks at once, including the one on screen, and keeps the rest', async () => {
    const manager = new BrowserManager();
    const window = new BrowserWindow();
    for (const id of ['a', 'b', 'c', 'd']) await open(manager, id);
    manager.setPane(window, 'b', bounds);

    await Promise.all(['a', 'b', 'c', 'a'].map(id => manager.closeSession(id)));

    const { sessions, byContents, pane } = internals(manager);
    expect([...sessions.keys()]).toEqual(['d']);
    expect([...byContents.values()]).toEqual(sessions.get('d')?.list);
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
  type Internals = { sessions: Map<string, { list: unknown[] }>; byContents: Map<number, unknown>; pane: unknown };
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
    expect(lastState().activeTabId).toBe(2);
    press(2, 'BracketLeft', true);
    expect(lastState().activeTabId).toBe(1);
    press(1, 'BracketLeft', true);
    expect(lastState().activeTabId).toBe(2);
    press(2, 'KeyW');
    await vi.waitFor(() => expect(tabIds()).toEqual([1]));
    expect(press(1, 'KeyA')).not.toHaveBeenCalled();
  });
});
